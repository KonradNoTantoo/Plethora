const chai = require('chai')
const ethers = require('ethers')
const {createMockProvider, deployContract, getWallets, solidity} = require('ethereum-waffle')

const Plethora = require('../build/Plethora')
const Book = require('../build/Book')
const BookFactory = require('../build/BookFactory')
const CallMarketPlace = require('../build/CallMarketPlace')
const CoveredEthCallBook = require('../build/CoveredEthCallBook')
const PutMarketPlace = require('../build/PutMarketPlace')
const CoveredEthPutBook = require('../build/CoveredEthPutBook')

chai.use(solidity)
const {expect} = chai


function now() { return Math.floor(Date.now()/1000) }
const SECONDS_IN_A_DAY = 60*60*24
const PRICE_ADJUSTMENT = 2**3
function adjust_price(p) { return Math.floor(p*PRICE_ADJUSTMENT) }
function nominal_value(q, p) { return q.mul(p).div(PRICE_ADJUSTMENT) }


describe('CallMarketPlace', function() {
	let provider = createMockProvider()
	let [admin, client1, client2, client3] = getWallets(provider)
	let token
	let factory
	let market
	let client1_book
	let client2_book
	let client3_book
	let book
	let option_book
	const quantity_unit = ethers.utils.parseEther('0.01')
	const price_unit = ethers.utils.bigNumberify(adjust_price(0.125))
	const max_gas = { gasLimit: 6000000 }
	const strike = 100.3

	function q(qty) { return quantity_unit.mul(qty) }
	function p(px) { return price_unit.mul(px) }

	async function mint_and_approve(wallet, qty) {
		const connection = token.connect(wallet)
		await connection.mint(qty)
		await connection.approve(option_book.address, qty)
	}

	beforeEach(async () => {
		token = await deployContract(admin, Plethora, [])
		factory = await deployContract(admin, BookFactory, [])
		market = await deployContract(admin, CallMarketPlace, [token.address, factory.address], max_gas)

		const in_two_days = now() + 2*SECONDS_IN_A_DAY

		const gas_and_value = {
			gasLimit: 6000000,
			value: ethers.utils.parseEther('0.01')
		}

		await expect(market.open_book(in_two_days, adjust_price(strike), quantity_unit, gas_and_value))
			.to.emit(market, "BookOpened")

		const option_book_address = await market.get_book_address( in_two_days, adjust_price(strike) )
		expect(option_book_address).is.not.eq(0)

		option_book = new ethers.Contract(option_book_address, CoveredEthCallBook.abi, admin)
		client1_book = new ethers.Contract(option_book_address, CoveredEthCallBook.abi, client1)
		client2_book = new ethers.Contract(option_book_address, CoveredEthCallBook.abi, client2)
		client3_book = new ethers.Contract(option_book_address, CoveredEthCallBook.abi, client3)

		const book_address = await option_book._book()
		book = new ethers.Contract(book_address, Book.abi, admin)
	})

	it('Bad orders', async () => {
		// missing tokens
		await expect(client1_book.buy(q(100), p(3), max_gas))
			.to.be.reverted

		const nominal = nominal_value(q(100), p(3))
		const tokenFromClient1 = token.connect(client1)
		await tokenFromClient1.approve(option_book.address, nominal)

		// even with approved tokens the following order should revert
		// because of bad quantity
		await expect(client1_book.buy(100, p(3), max_gas))
			.to.be.reverted

		// missing ethers
		await expect(client1_book.sell(q(100), p(3)))
			.to.be.reverted
	})

	it('Place buy order', async () => {
		const qty = q(100)
		const px = p(3)
		const nominal = nominal_value(qty, px)

		await mint_and_approve(client1, nominal)
		await client1_book.buy(qty, px, max_gas)

		expect(await token.balanceOf(option_book.address)).is.eq(nominal)
		expect(await token.balanceOf(client1.address)).is.eq(0)

		const order_id = await book.ask_order(0, 0)
		const order = await book._orders(order_id)
		expect(order.is_buy).to.eq(1)
	})

	it('Place sell order', async () => {
		const qty = q(100)
		const px = p(3)

		const gas_and_value = {
			gasLimit: 6000000,
			value: qty
		}

		await client1_book.sell(qty, px, gas_and_value)
		const order_id = await book.bid_order(0, 0)
		const order = await book._orders(order_id)
		expect(order.is_buy).to.eq(0)
	})

	it('Trigger full buy execution', async () => {
		const buy_qty = q(100)
		const buy_px = p(3)
		const buy_nominal = nominal_value(buy_qty, buy_px)
		const sell_qty = q(200)
		const sell_px = p(2)

		const gas_and_value = {
			gasLimit: 6000000,
			value: sell_qty
		}

		await client1_book.sell(sell_qty, sell_px, gas_and_value)

		const order_id = await book.bid_order(0, 0)
		const order = await book._orders(order_id)
		expect(order.is_buy).to.eq(0)

		await mint_and_approve(client2, buy_nominal)

		// TODO to.emit doesn't work on contracts created directly through ethers.js API
		// await expect(client2_book.buy(buy_qty, buy_px, max_gas))
		//  	.to.emit(book, 'Hit')
		//  	.withArgs(order_id, client2.address, client1.address, sell_px, buy_qty)
		await client2_book.buy(buy_qty, buy_px, max_gas)

		const exec_nominal = nominal_value(sell_px, buy_qty)

		expect(await token.balanceOf(option_book.address)).is.eq(0)
		expect(await token.balanceOf(client1.address)).is.eq(exec_nominal)
		expect(await token.balanceOf(client2.address)).is.eq(buy_nominal.sub(exec_nominal))
		expect(await option_book.balanceOf(client1.address)).is.eq(sell_qty.sub(buy_qty))
		expect(await option_book.balanceOf(client2.address)).is.eq(buy_qty)
	})

	it('Trigger partial buy execution', async () => {
		const sell_qty = q(100)
		const buy_qty = sell_qty.mul(3)

		const buy_px = p(3)
		const buy_nominal = nominal_value(buy_qty, buy_px)
		const sell_px_1 = p(2)
		const sell_px_2 = buy_px

		const gas_and_value = {
			gasLimit: 6000000,
			value: sell_qty
		}

		await client1_book.sell(sell_qty, sell_px_1, gas_and_value)
		await client2_book.sell(sell_qty, sell_px_2, gas_and_value)

		const sell_order_id_2 = await book.bid_order(0, 0)
		const sell_order_2 = await book._orders(sell_order_id_2)
		expect(sell_order_2.is_buy).to.eq(0)

		const sell_order_id_1 = await book.bid_order(1, 0)
		const sell_order_1 = await book._orders(sell_order_id_1)
		expect(sell_order_1.is_buy).to.eq(0)

		await mint_and_approve(client3, buy_nominal)
		await client3_book.buy(buy_qty, buy_px, max_gas)

		const exec_1_nominal = nominal_value(sell_qty, sell_px_1)
		const exec_2_nominal = nominal_value(sell_qty, sell_px_2)
		const remaining_buy_nominal = nominal_value(buy_qty.sub(sell_qty).sub(sell_qty), buy_px)

		expect(await token.balanceOf(client1.address)).is.eq(exec_1_nominal)
		expect(await token.balanceOf(client2.address)).is.eq(exec_2_nominal)
		expect(await token.balanceOf(option_book.address)).is.eq(remaining_buy_nominal)
		expect(await token.balanceOf(client3.address)).is.eq(
			buy_nominal
				.sub(exec_1_nominal)
				.sub(exec_2_nominal)
				.sub(remaining_buy_nominal))
		expect(await option_book.balanceOf(client1.address)).is.eq(0)
		expect(await option_book.balanceOf(client2.address)).is.eq(0)
		expect(await option_book.balanceOf(client3.address)).is.eq(sell_qty.mul(2))
	})

	it('Trigger full sell execution', async () => {
		const buy_qty = q(200)
		const buy_px = p(3)
		const buy_nominal = nominal_value(buy_qty, buy_px)
		const sell_qty = q(100)
		const sell_px = p(2)

		const gas_and_value = {
			gasLimit: 6000000,
			value: sell_qty
		}

		await client1_book.sell(sell_qty, sell_px, gas_and_value)

		const order_id = await book.bid_order(0, 0)
		const order = await book._orders(order_id)
		expect(order.is_buy).to.eq(0)

		await mint_and_approve(client2, buy_nominal)
		await client2_book.buy(buy_qty, buy_px, max_gas)

		const exec_nominal = nominal_value(sell_px, sell_qty)
		const remaining_buy_nominal = nominal_value(buy_qty.sub(sell_qty), buy_px)

		expect(await token.balanceOf(option_book.address)).is.eq(remaining_buy_nominal)
		expect(await token.balanceOf(client1.address)).is.eq(exec_nominal)
		expect(await token.balanceOf(client2.address)).is.eq(buy_nominal.sub(exec_nominal).sub(remaining_buy_nominal))
		expect(await option_book.balanceOf(client1.address)).is.eq(0)
		expect(await option_book.balanceOf(client2.address)).is.eq(sell_qty)
	})

	it('Trigger full secondary sell execution', async () => {
		const buy_qty = q(100)
		const buy_px = p(3)
		const buy_nominal = nominal_value(buy_qty, buy_px)
		const sell_qty = buy_qty
		const sell_px = p(2)

		const gas_and_value = {
			gasLimit: 6000000,
			value: sell_qty
		}

		await client1_book.sell(sell_qty, sell_px, gas_and_value)

		const order_id = await book.bid_order(0, 0)
		const order = await book._orders(order_id)
		expect(order.is_buy).to.eq(0)

		await mint_and_approve(client2, buy_nominal)
		await client2_book.buy(buy_qty, buy_px, max_gas)

		const exec_nominal = nominal_value(sell_px, sell_qty)

		expect(await token.balanceOf(option_book.address)).is.eq(0)
		expect(await token.balanceOf(client1.address)).is.eq(exec_nominal)
		expect(await token.balanceOf(client2.address)).is.eq(buy_nominal.sub(exec_nominal))
		expect(await option_book.balanceOf(client1.address)).is.eq(0)
		expect(await option_book.balanceOf(client2.address)).is.eq(sell_qty)

		expect(await book.bid_size()).is.eq(1)
		expect(await book.ask_size()).is.eq(0)

		await client2_book.sell(sell_qty, sell_px, max_gas)

		await mint_and_approve(client3, buy_nominal)
		await client3_book.buy(buy_qty, buy_px, max_gas)

		expect(await token.balanceOf(option_book.address)).is.eq(0)
		expect(await token.balanceOf(client2.address)).is.eq(buy_nominal)
		expect(await token.balanceOf(client3.address)).is.eq(buy_nominal.sub(exec_nominal))
		expect(await option_book.balanceOf(client2.address)).is.eq(0)
		expect(await option_book.balanceOf(client3.address)).is.eq(sell_qty)
	})

	it('Trigger partial sell execution', async () => {
		const buy_qty = q(100)
		const sell_qty = buy_qty.mul(4)

		const buy_px_1 = p(2)
		const buy_px_2 = p(3)
		const buy_nominal_1 = nominal_value(buy_qty, buy_px_1)
		const buy_nominal_2 = nominal_value(buy_qty, buy_px_2)
		const sell_px= p(2)

		await mint_and_approve(client1, buy_nominal_1)
		await client1_book.buy(buy_qty, buy_px_1, max_gas)

		await mint_and_approve(client2, buy_nominal_2)
		await client2_book.buy(buy_qty, buy_px_2, max_gas)

		const gas_and_value = {
			gasLimit: 6000000,
			value: sell_qty
		}

		await client3_book.sell(sell_qty, sell_px, gas_and_value)

		const exec_1_nominal = nominal_value(buy_px_1, buy_qty)
		const exec_2_nominal = nominal_value(buy_px_2, buy_qty)
		const remaining_sell_quantity = sell_qty.sub(buy_qty).sub(buy_qty)

		expect(await token.balanceOf(client1.address)).is.eq(0)
		expect(await token.balanceOf(client2.address)).is.eq(0)
		expect(await token.balanceOf(option_book.address)).is.eq(0)
		expect(await token.balanceOf(client3.address)).is.eq(exec_1_nominal.add(exec_2_nominal))
		expect(await option_book.balanceOf(client1.address)).is.eq(buy_qty)
		expect(await option_book.balanceOf(client2.address)).is.eq(buy_qty)
		expect(await option_book.balanceOf(client3.address)).is.eq(remaining_sell_quantity)
	})

	it('Trigger partial secondary sell execution', async () => {
		const buy_qty = q(100)
		const buy_px = p(3)
		const buy_nominal = nominal_value(buy_qty, buy_px)
		const sell_qty = buy_qty
		const sell_px = p(2)

		const gas_and_value = {
			gasLimit: 6000000,
			value: sell_qty
		}

		await client1_book.sell(sell_qty, sell_px, gas_and_value)

		await mint_and_approve(client2, buy_nominal)
		await client2_book.buy(buy_qty, buy_px, max_gas)

		const exec_nominal = nominal_value(sell_px, sell_qty)

		expect(await token.balanceOf(option_book.address)).is.eq(0)
		expect(await token.balanceOf(client1.address)).is.eq(exec_nominal)
		expect(await token.balanceOf(client2.address)).is.eq(buy_nominal.sub(exec_nominal))
		expect(await option_book.balanceOf(client1.address)).is.eq(0)
		expect(await option_book.balanceOf(client2.address)).is.eq(sell_qty)

		expect(await book.bid_size()).is.eq(1)
		expect(await book.ask_size()).is.eq(0)

		await client2_book.sell(sell_qty, sell_px, max_gas)

		const second_buy_qty = q(50)
		const second_buy_nominal = nominal_value(second_buy_qty, buy_px)

		await mint_and_approve(client3, second_buy_nominal)
		await client3_book.buy(second_buy_qty, buy_px, max_gas)

		const second_exec_nominal = nominal_value(second_buy_qty, sell_px)

		expect(await token.balanceOf(option_book.address)).is.eq(0)
		expect(await token.balanceOf(client2.address)).is.eq(buy_nominal.sub(exec_nominal).add(second_exec_nominal))
		expect(await token.balanceOf(client3.address)).is.eq(second_buy_nominal.sub(second_exec_nominal))
		expect(await option_book.balanceOf(client2.address)).is.eq(sell_qty.sub(second_buy_qty))
		expect(await option_book.balanceOf(client3.address)).is.eq(second_buy_qty)
	})
})


describe('PutMarketPlace', function() {
	let provider = createMockProvider()
	let [admin, client1, client2, client3] = getWallets(provider)
	let token
	let factory
	let market
	let client1_book
	let client2_book
	let client3_book
	let book
	let option_book
	const quantity_unit = ethers.utils.parseEther('0.01')
	const price_unit = ethers.utils.bigNumberify(adjust_price(0.125))
	const max_gas = { gasLimit: 6000000 }
	const strike = 100.4

	function q(qty) { return quantity_unit.mul(qty) }
	function p(px) { return price_unit.mul(px) }

	async function mint_and_approve(wallet, qty) {
		const connection = token.connect(wallet)
		await connection.mint(qty)
		await connection.approve(option_book.address, qty)
	}

	beforeEach(async () => {
		token = await deployContract(admin, Plethora, [])
		factory = await deployContract(admin, BookFactory, [])
		market = await deployContract(admin, PutMarketPlace, [token.address, factory.address], max_gas)

		const in_two_days = now() + 2*SECONDS_IN_A_DAY

		const gas_and_value = {
			gasLimit: 6000000,
			value: ethers.utils.parseEther('0.01')
		}

		await expect(market.open_book(in_two_days, adjust_price(strike), quantity_unit, gas_and_value))
			.to.emit(market, "BookOpened")

		const option_book_address = await market.get_book_address( in_two_days, adjust_price(strike) )
		expect(option_book_address).is.not.eq(0)

		option_book = new ethers.Contract(option_book_address, CoveredEthPutBook.abi, admin)
		client1_book = new ethers.Contract(option_book_address, CoveredEthPutBook.abi, client1)
		client2_book = new ethers.Contract(option_book_address, CoveredEthPutBook.abi, client2)
		client3_book = new ethers.Contract(option_book_address, CoveredEthPutBook.abi, client3)

		const book_address = await option_book._book()
		book = new ethers.Contract(book_address, Book.abi, admin)
	})

	it('Bad orders', async () => {
		// missing tokens
		await expect(client1_book.buy(q(100), p(3), max_gas))
			.to.be.reverted
		await expect(client1_book.sell(q(100), p(3), max_gas))
			.to.be.reverted

		const nominal = nominal_value(q(100), p(3))
		const tokenFromClient1 = token.connect(client1)
		await tokenFromClient1.approve(option_book.address, nominal)

		// even with approved tokens the following 2 orders should revert
		// because of bad quantity or price
		await expect(client1_book.buy(100, p(3), max_gas))
			.to.be.reverted
		await expect(client1_book.buy(q(100), 3, max_gas))
			.to.be.reverted

		// even with approved tokens the following 2 orders should revert
		// because of bad quantity or price
		await expect(client1_book.sell(100, p(3), max_gas))
			.to.be.reverted
		await expect(client1_book.sell(q(100), 3, max_gas))
			.to.be.reverted
	})

	it('Place buy order', async () => {
		const qty = q(100)
		const px = p(3)
		const nominal = nominal_value(qty, px)

		await mint_and_approve(client1, nominal)
		await client1_book.buy(qty, px, max_gas)

		expect(await token.balanceOf(option_book.address)).is.eq(nominal)
		expect(await token.balanceOf(client1.address)).is.eq(0)

		const order_id = await book.ask_order(0, 0)
		const order = await book._orders(order_id)
		expect(order.is_buy).to.eq(1)
	})

	it('Place sell order', async () => {
		const qty = q(100)
		const px = p(3)
		const put_nominal = nominal_value(qty, adjust_price(strike))

		await mint_and_approve(client1, put_nominal)
		await client1_book.sell(qty, px, max_gas)

		expect(await token.balanceOf(client1.address)).is.eq(0)
		expect(await token.balanceOf(option_book.address)).is.eq(put_nominal)
		expect(await option_book.balanceOf(client1.address)).is.eq(qty)

		const order_id = await book.bid_order(0, 0)
		const order = await book._orders(order_id)
		expect(order.is_buy).to.eq(0)
	})

	it('Trigger full buy execution', async () => {
		const buy_qty = q(100)
		const buy_px = p(3)
		const buy_nominal = nominal_value(buy_qty, buy_px)
		const sell_qty = q(200)
		const sell_px = p(2)
		const put_nominal = nominal_value(sell_qty, adjust_price(strike))

		await mint_and_approve(client1, put_nominal)
		await client1_book.sell(sell_qty, sell_px, max_gas)

		expect(await option_book.balanceOf(client1.address)).is.eq(sell_qty)

		await mint_and_approve(client2, buy_nominal)
		await client2_book.buy(buy_qty, buy_px, max_gas)

		const exec_nominal = nominal_value(sell_px, buy_qty)

		expect(await token.balanceOf(option_book.address)).is.eq(put_nominal)
		expect(await token.balanceOf(client1.address)).is.eq(exec_nominal)
		expect(await token.balanceOf(client2.address)).is.eq(buy_nominal.sub(exec_nominal))
		expect(await option_book.balanceOf(client1.address)).is.eq(sell_qty.sub(buy_qty))
		expect(await option_book.balanceOf(client2.address)).is.eq(buy_qty)
	})

	it('Trigger partial buy execution', async () => {
		const sell_qty = q(100)
		const buy_qty = sell_qty.mul(3)

		const buy_px = p(3)
		const buy_nominal = nominal_value(buy_qty, buy_px)
		const sell_px_1 = p(2)
		const sell_px_2 = buy_px
		const put_nominal = nominal_value(sell_qty, adjust_price(strike))

		await mint_and_approve(client1, put_nominal)
		await client1_book.sell(sell_qty, sell_px_1, max_gas)

		await mint_and_approve(client2, put_nominal)
		await client2_book.sell(sell_qty, sell_px_2, max_gas)

		expect(await option_book.balanceOf(client2.address)).is.eq(sell_qty)
		expect(await option_book.balanceOf(client1.address)).is.eq(sell_qty)

		await mint_and_approve(client3, buy_nominal)
		await client3_book.buy(buy_qty, buy_px, max_gas)

		const exec_1_nominal = nominal_value(sell_px_1, sell_qty)
		const exec_2_nominal = nominal_value(sell_px_2, sell_qty)
		const remaining_buy_nominal = nominal_value(buy_qty.sub(sell_qty).sub(sell_qty), buy_px)

		expect(await token.balanceOf(client1.address)).is.eq(exec_1_nominal)
		expect(await token.balanceOf(client2.address)).is.eq(exec_2_nominal)
		expect(await token.balanceOf(option_book.address)).is.eq(remaining_buy_nominal.add(put_nominal.mul(2)))
		expect(await token.balanceOf(client3.address)).is.eq(
			buy_nominal
				.sub(exec_1_nominal)
				.sub(exec_2_nominal)
				.sub(remaining_buy_nominal))
		expect(await option_book.balanceOf(client1.address)).is.eq(0)
		expect(await option_book.balanceOf(client2.address)).is.eq(0)
		expect(await option_book.balanceOf(client3.address)).is.eq(sell_qty.mul(2))
	})

	it('Trigger full sell execution', async () => {
		const buy_qty = q(200)
		const buy_px = p(3)
		const buy_nominal = nominal_value(buy_qty, buy_px)
		const sell_qty = q(100)
		const sell_px = p(2)
		const put_nominal = nominal_value(sell_qty, adjust_price(strike))

		await mint_and_approve(client1, put_nominal)
		await client1_book.sell(sell_qty, sell_px, max_gas)

		expect(await option_book.balanceOf(client1.address)).is.eq(sell_qty)

		await mint_and_approve(client2, buy_nominal)
		await client2_book.buy(buy_qty, buy_px, max_gas)

		const exec_nominal = nominal_value(sell_px, sell_qty)
		const remaining_buy_nominal = nominal_value(buy_qty.sub(sell_qty), buy_px)

		expect(await token.balanceOf(option_book.address)).is.eq(remaining_buy_nominal.add(put_nominal))
		expect(await token.balanceOf(client1.address)).is.eq(exec_nominal)
		expect(await token.balanceOf(client2.address)).is.eq(buy_nominal.sub(exec_nominal).sub(remaining_buy_nominal))
		expect(await option_book.balanceOf(client1.address)).is.eq(0)
		expect(await option_book.balanceOf(client2.address)).is.eq(sell_qty)
	})

	it('Trigger full secondary sell execution', async () => {
		const buy_qty = q(100)
		const buy_px = p(3)
		const buy_nominal = nominal_value(buy_qty, buy_px)
		const sell_qty = buy_qty
		const sell_px = p(2)
		const put_nominal = nominal_value(sell_qty, adjust_price(strike))

		await mint_and_approve(client1, put_nominal)
		await client1_book.sell(sell_qty, sell_px, max_gas)

		expect(await option_book.balanceOf(client1.address)).is.eq(sell_qty)

		await mint_and_approve(client2, buy_nominal)
		await client2_book.buy(buy_qty, buy_px, max_gas)

		const exec_nominal = nominal_value(sell_px, sell_qty)

		expect(await token.balanceOf(option_book.address)).is.eq(put_nominal)
		expect(await token.balanceOf(client1.address)).is.eq(exec_nominal)
		expect(await token.balanceOf(client2.address)).is.eq(buy_nominal.sub(exec_nominal))
		expect(await option_book.balanceOf(client1.address)).is.eq(0)
		expect(await option_book.balanceOf(client2.address)).is.eq(sell_qty)

		expect(await book.bid_size()).is.eq(1)
		expect(await book.ask_size()).is.eq(0)

		await client2_book.sell(sell_qty, sell_px, max_gas)

		await mint_and_approve(client3, buy_nominal)
		await client3_book.buy(buy_qty, buy_px, max_gas)

		expect(await token.balanceOf(option_book.address)).is.eq(put_nominal)
		expect(await token.balanceOf(client2.address)).is.eq(buy_nominal)
		expect(await token.balanceOf(client3.address)).is.eq(buy_nominal.sub(exec_nominal))
		expect(await option_book.balanceOf(client2.address)).is.eq(0)
		expect(await option_book.balanceOf(client3.address)).is.eq(sell_qty)
	})

	it('Trigger partial sell execution', async () => {
		const buy_qty = q(100)
		const sell_qty = buy_qty.mul(4)

		const buy_px_1 = p(2)
		const buy_px_2 = p(3)
		const buy_nominal_1 = nominal_value(buy_qty, buy_px_1)
		const buy_nominal_2 = nominal_value(buy_qty, buy_px_2)
		const sell_px= p(2)

		await mint_and_approve(client1, buy_nominal_1)
		await client1_book.buy(buy_qty, buy_px_1, max_gas)

		await mint_and_approve(client2, buy_nominal_2)
		await client2_book.buy(buy_qty, buy_px_2, max_gas)

		const put_nominal = nominal_value(sell_qty, adjust_price(strike))

		await mint_and_approve(client3, put_nominal)
		await client3_book.sell(sell_qty, sell_px, max_gas)

		const exec_1_nominal = nominal_value(buy_qty, buy_px_1)
		const exec_2_nominal = nominal_value(buy_qty, buy_px_2)
		const remaining_sell_quantity = sell_qty.sub(buy_qty).sub(buy_qty)

		expect(await token.balanceOf(client1.address)).is.eq(0)
		expect(await token.balanceOf(client2.address)).is.eq(0)
		expect(await token.balanceOf(option_book.address)).is.eq(put_nominal)
		expect(await token.balanceOf(client3.address)).is.eq(exec_1_nominal.add(exec_2_nominal))
		expect(await option_book.balanceOf(client1.address)).is.eq(buy_qty)
		expect(await option_book.balanceOf(client2.address)).is.eq(buy_qty)
		expect(await option_book.balanceOf(client3.address)).is.eq(remaining_sell_quantity)
	})

	it('Trigger partial secondary sell execution', async () => {
		const buy_qty = q(100)
		const buy_px = p(3)
		const buy_nominal = nominal_value(buy_qty, buy_px)
		const sell_qty = buy_qty
		const sell_px = p(2)
		const put_nominal = nominal_value(sell_qty, adjust_price(strike))

		await mint_and_approve(client1, put_nominal)
		await client1_book.sell(sell_qty, sell_px, max_gas)

		expect(await option_book.balanceOf(client1.address)).is.eq(sell_qty)

		await mint_and_approve(client2, buy_nominal)
		await client2_book.buy(buy_qty, buy_px, max_gas)

		const exec_nominal = nominal_value(sell_px, sell_qty)

		expect(await token.balanceOf(option_book.address)).is.eq(put_nominal)
		expect(await token.balanceOf(client1.address)).is.eq(exec_nominal)
		expect(await token.balanceOf(client2.address)).is.eq(buy_nominal.sub(exec_nominal))
		expect(await option_book.balanceOf(client1.address)).is.eq(0)
		expect(await option_book.balanceOf(client2.address)).is.eq(sell_qty)

		expect(await book.bid_size()).is.eq(1)
		expect(await book.ask_size()).is.eq(0)

		await client2_book.sell(sell_qty, sell_px, max_gas)

		const second_buy_qty = q(50)
		const second_buy_nominal = nominal_value(second_buy_qty, buy_px)

		await mint_and_approve(client3, second_buy_nominal)
		await client3_book.buy(second_buy_qty, buy_px, max_gas)

		const second_exec_nominal = nominal_value(sell_px, second_buy_qty)

		expect(await token.balanceOf(option_book.address)).is.eq(put_nominal)
		expect(await token.balanceOf(client2.address)).is.eq(buy_nominal.sub(exec_nominal).add(second_exec_nominal))
		expect(await token.balanceOf(client3.address)).is.eq(second_buy_nominal.sub(second_exec_nominal))
		expect(await option_book.balanceOf(client2.address)).is.eq(sell_qty.sub(second_buy_qty))
		expect(await option_book.balanceOf(client3.address)).is.eq(second_buy_qty)
	})
})
