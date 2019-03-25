const chai = require('chai')
const ethers = require('ethers')
const {createMockProvider, deployContract, getWallets, solidity} = require('ethereum-waffle')

const Plethora = require('../build/Plethora')
const Book = require('../build/Book')
const BookFactory = require('../build/BookFactory')
const CallMarketPlace = require('../build/CallMarketPlace')
const CoveredEthCall = require('../build/CoveredEthCall')
const PutMarketPlace = require('../build/PutMarketPlace')
const CoveredEthPut = require('../build/CoveredEthPut')

chai.use(solidity)
const {expect} = chai


function now() { return Math.floor(Date.now()/1000) }
function offset_to_expiry( offset ) { return 1546351200 + offset }
const SECONDS_IN_A_DAY = 60*60*24


describe('CallMarketPlace', function() {
	this.timeout(4000)

	let provider = createMockProvider()
	let [admin, client1, client2, client3] = getWallets(provider)
	let token
	let factory
	let market
	let client1_market
	let client2_market
	let client3_market
	let book
	let book_address
	const minimum_quantity = ethers.utils.parseEther('0.01')
	const tick_size = ethers.utils.parseEther('0.0001')
	const max_order_lifetime = SECONDS_IN_A_DAY
	const max_gas = { gasLimit: 6000000 }
	const underlying_nominal = ethers.utils.parseEther('1.0')
	const strike = 100
	const nb_tokens = underlying_nominal.mul(strike)

	function q(qty) { return minimum_quantity.add(qty) }
	function p(px) { return tick_size.mul(px) }

	async function call_from_order_id(order_id) {
		const order = await book.get_order(order_id)
		expect(ethers.utils.bigNumberify(order.user_data).isZero()).to.be.false
		return new ethers.Contract(order.user_data, CoveredEthCall.abi, admin)
	}

	async function mint_and_approve(wallet, qty) {
		const connection = token.connect(wallet)
		await connection.mint(qty)
		await connection.approve(market.address, qty)
	}

	beforeEach(async () => {
		token = await deployContract(admin, Plethora, [])
		factory = await deployContract(admin, BookFactory, [])
		market = await deployContract(admin, CallMarketPlace, [token.address, factory.address], max_gas)

		client1_market = market.connect(client1)
		client2_market = market.connect(client2)
		client3_market = market.connect(client3)

		const today_offset = Math.floor( await market.to_expiry_offset(now()) / SECONDS_IN_A_DAY )
		const in_two_days_offset = (today_offset + 2)*SECONDS_IN_A_DAY

		const gas_and_value = {
			gasLimit: 6000000,
			value: ethers.utils.parseEther('0.001')
		}

		await expect(market.open_book(in_two_days_offset, strike, minimum_quantity, tick_size, max_order_lifetime, gas_and_value))
			.to.emit(market, "BookOpened")

		book_address = await market.get_book_address( offset_to_expiry((today_offset + 2)*SECONDS_IN_A_DAY), strike )
		expect(book_address).is.not.eq(0)
		book = new ethers.Contract(book_address, Book.abi, admin)
	})

	it('Bad orders', async () => {
		// missing tokens
		await expect(client1_market.buy(book_address, q(100), p(3), max_gas))
			.to.be.reverted

		const nominal = q(100).mul(strike)
		const tokenFromClient1 = token.connect(client1)
		await tokenFromClient1.approve(market.address, nominal)

		// even with approved tokens the following 2 orders should revert
		// because of bad quantity or price
		await expect(client1_market.buy(book_address, 100, p(3), max_gas))
			.to.be.reverted
		await expect(client1_market.buy(book_address, q(100), 3, max_gas))
			.to.be.reverted

		await expect(client1_market.sell(book_address, p(3), max_gas))
			.to.be.reverted

		const gas_and_value = {
			gasLimit: 6000000,
			value: q(100)
		}

		await expect(client1_market.sell(book_address, 3, gas_and_value))
			.to.be.reverted
	})

	it('Place buy order', async () => {
		const qty = q(100)
		const px = p(3)
		const nominal = qty.mul(px)

		await mint_and_approve(client1, nominal)
		await client1_market.buy(book_address, qty, px, max_gas)

		expect(await token.balanceOf(market.address)).is.eq(nominal)
		expect(await token.balanceOf(client1.address)).is.eq(0)

		const order_id = await book.ask_order(0, 0)
		const order = await book.get_order(order_id)
		expect(ethers.utils.bigNumberify(order.user_data).isZero()).to.be.true
	})

	it('Place sell order', async () => {
		const qty = q(100)
		const px = p(3)

		const gas_and_value = {
			gasLimit: 6000000,
			value: qty
		}

		await expect(client1_market.sell(book_address, px, gas_and_value))
			.to.emit(market, 'CallEmission')
		const order_id = await book.bid_order(0, 0)
		const call = await call_from_order_id(order_id)
		expect(await call.balanceOf(client1.address)).is.eq(qty)
	})

	it('Trigger full buy execution', async () => {
		const buy_qty = q(100)
		const buy_px = p(3)
		const buy_nominal = buy_qty.mul(buy_px)
		const sell_qty = q(200)
		const sell_px = p(2)

		const gas_and_value = {
			gasLimit: 6000000,
			value: sell_qty
		}

		await expect(client1_market.sell(book_address, sell_px, gas_and_value))
			.to.emit(market, 'CallEmission')

		const order_id = await book.bid_order(0, 0)
		const call = await call_from_order_id(order_id)
		expect(await call.balanceOf(client1.address)).is.eq(sell_qty)

		await mint_and_approve(client2, buy_nominal)
		await expect(client2_market.buy(book_address, buy_qty, buy_px, max_gas))
		 	.to.emit(book, 'Hit')
		 	.withArgs(order_id, client2.address, client1.address, sell_px, buy_qty, '0x0000000000000000000000000000000000000000')

		const exec_nominal = sell_px.mul(buy_qty)

		expect(await token.balanceOf(market.address)).is.eq(0)
		expect(await token.balanceOf(client1.address)).is.eq(exec_nominal)
		expect(await token.balanceOf(client2.address)).is.eq(buy_nominal.sub(exec_nominal))
		expect(await call.balanceOf(client1.address)).is.eq(sell_qty.sub(buy_qty))
		expect(await call.balanceOf(client2.address)).is.eq(buy_qty)
	})

	it('Trigger partial buy execution', async () => {
		const sell_qty = q(100)
		const buy_qty = sell_qty.mul(3)

		const buy_px = p(3)
		const buy_nominal = buy_qty.mul(buy_px)
		const sell_px_1 = p(2)
		const sell_px_2 = buy_px

		const gas_and_value = {
			gasLimit: 6000000,
			value: sell_qty
		}

		await expect(client1_market.sell(book_address, sell_px_1, gas_and_value))
			.to.emit(market, 'CallEmission')

		await expect(client2_market.sell(book_address, sell_px_2, gas_and_value))
			.to.emit(market, 'CallEmission')

		const sell_order_id_1 = await book.bid_order(0, 0)
		const call_1 = await call_from_order_id(sell_order_id_1)
		expect(await call_1.balanceOf(client1.address)).is.eq(sell_qty)

		const sell_order_id_2 = await book.bid_order(1, 0)
		const call_2 = await call_from_order_id(sell_order_id_2)
		expect(await call_2.balanceOf(client2.address)).is.eq(sell_qty)

		await mint_and_approve(client3, buy_nominal)
		await client3_market.buy(book_address, buy_qty, buy_px, max_gas)

		const exec_1_nominal = sell_px_1.mul(sell_qty)
		const exec_2_nominal = sell_px_2.mul(sell_qty)
		const remaining_buy_nominal = buy_qty.sub(sell_qty).sub(sell_qty).mul(buy_px)

		expect(await token.balanceOf(client1.address)).is.eq(exec_1_nominal)
		expect(await token.balanceOf(client2.address)).is.eq(exec_2_nominal)
		expect(await token.balanceOf(market.address)).is.eq(remaining_buy_nominal)
		expect(await token.balanceOf(client3.address)).is.eq(
			buy_nominal
				.sub(exec_1_nominal)
				.sub(exec_2_nominal)
				.sub(remaining_buy_nominal))
		expect(await call_1.balanceOf(client1.address)).is.eq(0)
		expect(await call_1.balanceOf(client3.address)).is.eq(sell_qty)
		expect(await call_2.balanceOf(client2.address)).is.eq(0)
		expect(await call_2.balanceOf(client3.address)).is.eq(sell_qty)
	})

	it('Trigger full sell execution', async () => {
		const buy_qty = q(200)
		const buy_px = p(3)
		const buy_nominal = buy_qty.mul(buy_px)
		const sell_qty = q(100)
		const sell_px = p(2)

		const gas_and_value = {
			gasLimit: 6000000,
			value: sell_qty
		}

		await client1_market.sell(book_address, sell_px, gas_and_value)

		const order_id = await book.bid_order(0, 0)
		const call = await call_from_order_id(order_id)
		expect(await call.balanceOf(client1.address)).is.eq(sell_qty)

		await mint_and_approve(client2, buy_nominal)
		await client2_market.buy(book_address, buy_qty, buy_px, max_gas)

		const exec_nominal = sell_px.mul(sell_qty)
		const remaining_buy_nominal = buy_qty.sub(sell_qty).mul(buy_px)

		expect(await token.balanceOf(market.address)).is.eq(remaining_buy_nominal)
		expect(await token.balanceOf(client1.address)).is.eq(exec_nominal)
		expect(await token.balanceOf(client2.address)).is.eq(buy_nominal.sub(exec_nominal).sub(remaining_buy_nominal))
		expect(await call.balanceOf(client1.address)).is.eq(0)
		expect(await call.balanceOf(client2.address)).is.eq(sell_qty)
	})

	it('Trigger full secondary sell execution', async () => {
		const buy_qty = q(100)
		const buy_px = p(3)
		const buy_nominal = buy_qty.mul(buy_px)
		const sell_qty = buy_qty
		const sell_px = p(2)

		const gas_and_value = {
			gasLimit: 6000000,
			value: sell_qty
		}

		await client1_market.sell(book_address, sell_px, gas_and_value)

		const order_id = await book.bid_order(0, 0)
		const call = await call_from_order_id(order_id)
		expect(await call.balanceOf(client1.address)).is.eq(sell_qty)

		await mint_and_approve(client2, buy_nominal)
		await client2_market.buy(book_address, buy_qty, buy_px, max_gas)

		const exec_nominal = sell_px.mul(sell_qty)

		expect(await token.balanceOf(market.address)).is.eq(0)
		expect(await token.balanceOf(client1.address)).is.eq(exec_nominal)
		expect(await token.balanceOf(client2.address)).is.eq(buy_nominal.sub(exec_nominal))
		expect(await call.balanceOf(client1.address)).is.eq(0)
		expect(await call.balanceOf(client2.address)).is.eq(sell_qty)

		expect(await book.bid_size()).is.eq(1)
		expect(await book.ask_size()).is.eq(0)

		await client2_market.sell_secondary(book_address, sell_qty, sell_px, call.address, max_gas)

		await mint_and_approve(client3, buy_nominal)
		await client3_market.buy(book_address, buy_qty, buy_px, max_gas)

		expect(await token.balanceOf(market.address)).is.eq(0)
		expect(await token.balanceOf(client2.address)).is.eq(buy_nominal)
		expect(await token.balanceOf(client3.address)).is.eq(buy_nominal.sub(exec_nominal))
		expect(await call.balanceOf(client2.address)).is.eq(0)
		expect(await call.balanceOf(client3.address)).is.eq(sell_qty)
	})

	it('Trigger partial sell execution', async () => {
		const buy_qty = q(100)
		const sell_qty = buy_qty.mul(4)

		const buy_px_1 = p(2)
		const buy_px_2 = p(3)
		const buy_nominal_1 = buy_qty.mul(buy_px_1)
		const buy_nominal_2 = buy_qty.mul(buy_px_2)
		const sell_px= p(2)

		await mint_and_approve(client1, buy_nominal_1)
		await client1_market.buy(book_address, buy_qty, buy_px_1, max_gas)

		await mint_and_approve(client2, buy_nominal_2)
		await client2_market.buy(book_address, buy_qty, buy_px_2, max_gas)

		const gas_and_value = {
			gasLimit: 6000000,
			value: sell_qty
		}

		await client3_market.sell(book_address, sell_px, gas_and_value)

		const sell_order_id = await book.bid_order(0, 0)
		const call = await call_from_order_id(sell_order_id)

		const exec_1_nominal = buy_px_1.mul(buy_qty)
		const exec_2_nominal = buy_px_2.mul(buy_qty)
		const remaining_sell_quantity = sell_qty.sub(buy_qty).sub(buy_qty)

		expect(await token.balanceOf(client1.address)).is.eq(0)
		expect(await token.balanceOf(client2.address)).is.eq(0)
		expect(await token.balanceOf(market.address)).is.eq(0)
		expect(await token.balanceOf(client3.address)).is.eq(exec_1_nominal.add(exec_2_nominal))
		expect(await call.balanceOf(client1.address)).is.eq(buy_qty)
		expect(await call.balanceOf(client2.address)).is.eq(buy_qty)
		expect(await call.balanceOf(client3.address)).is.eq(remaining_sell_quantity)
	})

	it('Trigger partial secondary sell execution', async () => {
		const buy_qty = q(100)
		const buy_px = p(3)
		const buy_nominal = buy_qty.mul(buy_px)
		const sell_qty = buy_qty
		const sell_px = p(2)

		const gas_and_value = {
			gasLimit: 6000000,
			value: sell_qty
		}

		await client1_market.sell(book_address, sell_px, gas_and_value)

		const order_id = await book.bid_order(0, 0)
		const call = await call_from_order_id(order_id)
		expect(await call.balanceOf(client1.address)).is.eq(sell_qty)

		await mint_and_approve(client2, buy_nominal)
		await client2_market.buy(book_address, buy_qty, buy_px, max_gas)

		const exec_nominal = sell_px.mul(sell_qty)

		expect(await token.balanceOf(market.address)).is.eq(0)
		expect(await token.balanceOf(client1.address)).is.eq(exec_nominal)
		expect(await token.balanceOf(client2.address)).is.eq(buy_nominal.sub(exec_nominal))
		expect(await call.balanceOf(client1.address)).is.eq(0)
		expect(await call.balanceOf(client2.address)).is.eq(sell_qty)

		expect(await book.bid_size()).is.eq(1)
		expect(await book.ask_size()).is.eq(0)

		await client2_market.sell_secondary(book_address, sell_qty, sell_px, call.address, max_gas)

		const second_buy_qty = q(50)
		const second_buy_nominal = second_buy_qty.mul(buy_px)

		await mint_and_approve(client3, second_buy_nominal)
		await client3_market.buy(book_address, second_buy_qty, buy_px, max_gas)

		const second_exec_nominal = sell_px.mul(second_buy_qty)

		expect(await token.balanceOf(market.address)).is.eq(0)
		expect(await token.balanceOf(client2.address)).is.eq(buy_nominal.sub(exec_nominal).add(second_exec_nominal))
		expect(await token.balanceOf(client3.address)).is.eq(second_buy_nominal.sub(second_exec_nominal))
		expect(await call.balanceOf(client2.address)).is.eq(sell_qty.sub(second_buy_qty))
		expect(await call.balanceOf(client3.address)).is.eq(second_buy_qty)
	})
})


describe('PutMarketPlace', function() {
	this.timeout(4000)

	let provider = createMockProvider()
	let [admin, client1, client2, client3] = getWallets(provider)
	let token
	let factory
	let market
	let client1_market
	let client2_market
	let client3_market
	let book
	let book_address
	const minimum_quantity = ethers.utils.parseEther('0.01')
	const tick_size = ethers.utils.parseEther('0.0001')
	const max_order_lifetime = SECONDS_IN_A_DAY
	const max_gas = { gasLimit: 6000000 }
	const underlying_nominal = ethers.utils.parseEther('1.0')
	const strike = 100
	const nb_tokens = underlying_nominal.mul(strike)

	function q(qty) { return minimum_quantity.add(qty) }
	function p(px) { return tick_size.mul(px) }

	async function put_from_order_id(order_id) {
		const order = await book.get_order(order_id)
		expect(ethers.utils.bigNumberify(order.user_data).isZero()).to.be.false
		return new ethers.Contract(order.user_data, CoveredEthCall.abi, admin)
	}

	async function mint_and_approve(wallet, qty) {
		const connection = token.connect(wallet)
		await connection.mint(qty)
		await connection.approve(market.address, qty)
	}

	beforeEach(async () => {
		token = await deployContract(admin, Plethora, [])
		factory = await deployContract(admin, BookFactory, [])
		market = await deployContract(admin, PutMarketPlace, [token.address, factory.address], max_gas)

		client1_market = market.connect(client1)
		client2_market = market.connect(client2)
		client3_market = market.connect(client3)

		const today_offset = Math.floor( await market.to_expiry_offset(now()) / SECONDS_IN_A_DAY )
		const in_two_days_offset = (today_offset + 2)*SECONDS_IN_A_DAY

		const gas_and_value = {
			gasLimit: 6000000,
			value: ethers.utils.parseEther('0.001')
		}

		await expect(market.open_book(in_two_days_offset, strike, minimum_quantity, tick_size, max_order_lifetime, gas_and_value))
			.to.emit(market, "BookOpened")

		book_address = await market.get_book_address( offset_to_expiry((today_offset + 2)*SECONDS_IN_A_DAY), strike )
		expect(book_address).is.not.eq(0)
		book = new ethers.Contract(book_address, Book.abi, admin)
	})

	it('Bad orders', async () => {
		// missing tokens
		await expect(client1_market.buy(book_address, q(100), p(3), max_gas))
			.to.be.reverted
		await expect(client1_market.sell(book_address, q(100), p(3), max_gas))
			.to.be.reverted

		const nominal = q(100).mul(strike)
		const tokenFromClient1 = token.connect(client1)
		await tokenFromClient1.approve(market.address, nominal)

		// even with approved tokens the following 2 orders should revert
		// because of bad quantity or price
		await expect(client1_market.buy(book_address, 100, p(3), max_gas))
			.to.be.reverted
		await expect(client1_market.buy(book_address, q(100), 3, max_gas))
			.to.be.reverted

		// even with approved tokens the following 2 orders should revert
		// because of bad quantity or price
		await expect(client1_market.sell(book_address, 100, p(3), max_gas))
			.to.be.reverted
		await expect(client1_market.sell(book_address, q(100), 3, max_gas))
			.to.be.reverted
	})

	it('Place buy order', async () => {
		const qty = q(100)
		const px = p(3)
		const nominal = qty.mul(px)

		await mint_and_approve(client1, nominal)
		await client1_market.buy(book_address, qty, px, max_gas)

		expect(await token.balanceOf(market.address)).is.eq(nominal)
		expect(await token.balanceOf(client1.address)).is.eq(0)

		const order_id = await book.ask_order(0, 0)
		const order = await book.get_order(order_id)
		expect(ethers.utils.bigNumberify(order.user_data).isZero()).to.be.true
	})

	it('Place sell order', async () => {
		const qty = q(100)
		const px = p(3)
		const nominal = qty.mul(strike)

		await mint_and_approve(client1, nominal)
		await expect(client1_market.sell(book_address, qty, px, max_gas))
			.to.emit(market, 'PutEmission')

		const order_id = await book.bid_order(0, 0)
		const put = await put_from_order_id(order_id)

		expect(await token.balanceOf(client1.address)).is.eq(0)
		expect(await token.balanceOf(put.address)).is.eq(nominal)
		expect(await put.balanceOf(client1.address)).is.eq(qty)
	})

	it('Trigger full buy execution', async () => {
		const buy_qty = q(100)
		const buy_px = p(3)
		const buy_nominal = buy_qty.mul(buy_px)
		const sell_qty = q(200)
		const sell_px = p(2)
		const put_nominal = sell_qty.mul(strike)

		await mint_and_approve(client1, put_nominal)
		await expect(client1_market.sell(book_address, sell_qty, sell_px, max_gas))
			.to.emit(market, 'PutEmission')

		const order_id = await book.bid_order(0, 0)
		const put = await put_from_order_id(order_id)
		expect(await put.balanceOf(client1.address)).is.eq(sell_qty)

		await mint_and_approve(client2, buy_nominal)
		await expect(client2_market.buy(book_address, buy_qty, buy_px, max_gas))
		 	.to.emit(book, 'Hit')
		 	.withArgs(order_id, client2.address, client1.address, sell_px, buy_qty, '0x0000000000000000000000000000000000000000')

		const exec_nominal = sell_px.mul(buy_qty)

		expect(await token.balanceOf(market.address)).is.eq(0)
		expect(await token.balanceOf(put.address)).is.eq(put_nominal)
		expect(await token.balanceOf(client1.address)).is.eq(exec_nominal)
		expect(await token.balanceOf(client2.address)).is.eq(buy_nominal.sub(exec_nominal))
		expect(await put.balanceOf(client1.address)).is.eq(sell_qty.sub(buy_qty))
		expect(await put.balanceOf(client2.address)).is.eq(buy_qty)
	})

	it('Trigger partial buy execution', async () => {
		const sell_qty = q(100)
		const buy_qty = sell_qty.mul(3)

		const buy_px = p(3)
		const buy_nominal = buy_qty.mul(buy_px)
		const sell_px_1 = p(2)
		const sell_px_2 = buy_px
		const put_nominal = sell_qty.mul(strike)

		await mint_and_approve(client1, put_nominal)
		await expect(client1_market.sell(book_address, sell_qty, sell_px_1, max_gas))
			.to.emit(market, 'PutEmission')

		await mint_and_approve(client2, put_nominal)
		await expect(client2_market.sell(book_address, sell_qty, sell_px_2, max_gas))
			.to.emit(market, 'PutEmission')

		const sell_order_id_1 = await book.bid_order(0, 0)
		const put_1 = await put_from_order_id(sell_order_id_1)
		expect(await put_1.balanceOf(client1.address)).is.eq(sell_qty)

		const sell_order_id_2 = await book.bid_order(1, 0)
		const put_2 = await put_from_order_id(sell_order_id_2)
		expect(await put_2.balanceOf(client2.address)).is.eq(sell_qty)

		await mint_and_approve(client3, buy_nominal)
		await client3_market.buy(book_address, buy_qty, buy_px, max_gas)

		const exec_1_nominal = sell_px_1.mul(sell_qty)
		const exec_2_nominal = sell_px_2.mul(sell_qty)
		const remaining_buy_nominal = buy_qty.sub(sell_qty).sub(sell_qty).mul(buy_px)

		expect(await token.balanceOf(client1.address)).is.eq(exec_1_nominal)
		expect(await token.balanceOf(client2.address)).is.eq(exec_2_nominal)
		expect(await token.balanceOf(market.address)).is.eq(remaining_buy_nominal)
		expect(await token.balanceOf(client3.address)).is.eq(
			buy_nominal
				.sub(exec_1_nominal)
				.sub(exec_2_nominal)
				.sub(remaining_buy_nominal))
		expect(await token.balanceOf(put_1.address)).is.eq(put_nominal)
		expect(await token.balanceOf(put_2.address)).is.eq(put_nominal)
		expect(await put_1.balanceOf(client1.address)).is.eq(0)
		expect(await put_1.balanceOf(client3.address)).is.eq(sell_qty)
		expect(await put_2.balanceOf(client2.address)).is.eq(0)
		expect(await put_2.balanceOf(client3.address)).is.eq(sell_qty)
	})

	it('Trigger full sell execution', async () => {
		const buy_qty = q(200)
		const buy_px = p(3)
		const buy_nominal = buy_qty.mul(buy_px)
		const sell_qty = q(100)
		const sell_px = p(2)
		const put_nominal = sell_qty.mul(strike)

		await mint_and_approve(client1, put_nominal)
		await client1_market.sell(book_address, sell_qty, sell_px, max_gas)

		const order_id = await book.bid_order(0, 0)
		const put = await put_from_order_id(order_id)
		expect(await put.balanceOf(client1.address)).is.eq(sell_qty)

		await mint_and_approve(client2, buy_nominal)
		await client2_market.buy(book_address, buy_qty, buy_px, max_gas)

		const exec_nominal = sell_px.mul(sell_qty)
		const remaining_buy_nominal = buy_qty.sub(sell_qty).mul(buy_px)

		expect(await token.balanceOf(market.address)).is.eq(remaining_buy_nominal)
		expect(await token.balanceOf(client1.address)).is.eq(exec_nominal)
		expect(await token.balanceOf(client2.address)).is.eq(buy_nominal.sub(exec_nominal).sub(remaining_buy_nominal))
		expect(await put.balanceOf(client1.address)).is.eq(0)
		expect(await put.balanceOf(client2.address)).is.eq(sell_qty)
	})

	it('Trigger full secondary sell execution', async () => {
		const buy_qty = q(100)
		const buy_px = p(3)
		const buy_nominal = buy_qty.mul(buy_px)
		const sell_qty = buy_qty
		const sell_px = p(2)
		const put_nominal = sell_qty.mul(strike)

		await mint_and_approve(client1, put_nominal)
		await client1_market.sell(book_address, sell_qty, sell_px, max_gas)

		const order_id = await book.bid_order(0, 0)
		const put = await put_from_order_id(order_id)
		expect(await put.balanceOf(client1.address)).is.eq(sell_qty)

		await mint_and_approve(client2, buy_nominal)
		await client2_market.buy(book_address, buy_qty, buy_px, max_gas)

		const exec_nominal = sell_px.mul(sell_qty)

		expect(await token.balanceOf(market.address)).is.eq(0)
		expect(await token.balanceOf(client1.address)).is.eq(exec_nominal)
		expect(await token.balanceOf(client2.address)).is.eq(buy_nominal.sub(exec_nominal))
		expect(await put.balanceOf(client1.address)).is.eq(0)
		expect(await put.balanceOf(client2.address)).is.eq(sell_qty)

		expect(await book.bid_size()).is.eq(1)
		expect(await book.ask_size()).is.eq(0)

		await client2_market.sell_secondary(book_address, sell_qty, sell_px, put.address, max_gas)

		await mint_and_approve(client3, buy_nominal)
		await client3_market.buy(book_address, buy_qty, buy_px, max_gas)

		expect(await token.balanceOf(market.address)).is.eq(0)
		expect(await token.balanceOf(client2.address)).is.eq(buy_nominal)
		expect(await token.balanceOf(client3.address)).is.eq(buy_nominal.sub(exec_nominal))
		expect(await put.balanceOf(client2.address)).is.eq(0)
		expect(await put.balanceOf(client3.address)).is.eq(sell_qty)
	})

	it('Trigger partial sell execution', async () => {
		const buy_qty = q(100)
		const sell_qty = buy_qty.mul(4)

		const buy_px_1 = p(2)
		const buy_px_2 = p(3)
		const buy_nominal_1 = buy_qty.mul(buy_px_1)
		const buy_nominal_2 = buy_qty.mul(buy_px_2)
		const sell_px= p(2)

		await mint_and_approve(client1, buy_nominal_1)
		await client1_market.buy(book_address, buy_qty, buy_px_1, max_gas)

		await mint_and_approve(client2, buy_nominal_2)
		await client2_market.buy(book_address, buy_qty, buy_px_2, max_gas)

		const put_nominal = sell_qty.mul(strike)

		await mint_and_approve(client3, put_nominal)
		await client3_market.sell(book_address, sell_qty, sell_px, max_gas)

		const sell_order_id = await book.bid_order(0, 0)
		const put = await put_from_order_id(sell_order_id)

		const exec_1_nominal = buy_px_1.mul(buy_qty)
		const exec_2_nominal = buy_px_2.mul(buy_qty)
		const remaining_sell_quantity = sell_qty.sub(buy_qty).sub(buy_qty)

		expect(await token.balanceOf(client1.address)).is.eq(0)
		expect(await token.balanceOf(client2.address)).is.eq(0)
		expect(await token.balanceOf(market.address)).is.eq(0)
		expect(await token.balanceOf(client3.address)).is.eq(exec_1_nominal.add(exec_2_nominal))
		expect(await put.balanceOf(client1.address)).is.eq(buy_qty)
		expect(await put.balanceOf(client2.address)).is.eq(buy_qty)
		expect(await put.balanceOf(client3.address)).is.eq(remaining_sell_quantity)
	})

	it('Trigger partial secondary sell execution', async () => {
		const buy_qty = q(100)
		const buy_px = p(3)
		const buy_nominal = buy_qty.mul(buy_px)
		const sell_qty = buy_qty
		const sell_px = p(2)
		const put_nominal = sell_qty.mul(strike)

		await mint_and_approve(client1, put_nominal)
		await client1_market.sell(book_address, sell_qty, sell_px, max_gas)

		const order_id = await book.bid_order(0, 0)
		const put = await put_from_order_id(order_id)
		expect(await put.balanceOf(client1.address)).is.eq(sell_qty)

		await mint_and_approve(client2, buy_nominal)
		await client2_market.buy(book_address, buy_qty, buy_px, max_gas)

		const exec_nominal = sell_px.mul(sell_qty)

		expect(await token.balanceOf(market.address)).is.eq(0)
		expect(await token.balanceOf(client1.address)).is.eq(exec_nominal)
		expect(await token.balanceOf(client2.address)).is.eq(buy_nominal.sub(exec_nominal))
		expect(await put.balanceOf(client1.address)).is.eq(0)
		expect(await put.balanceOf(client2.address)).is.eq(sell_qty)

		expect(await book.bid_size()).is.eq(1)
		expect(await book.ask_size()).is.eq(0)

		await client2_market.sell_secondary(book_address, sell_qty, sell_px, put.address, max_gas)

		const second_buy_qty = q(50)
		const second_buy_nominal = second_buy_qty.mul(buy_px)

		await mint_and_approve(client3, second_buy_nominal)
		await client3_market.buy(book_address, second_buy_qty, buy_px, max_gas)

		const second_exec_nominal = sell_px.mul(second_buy_qty)

		expect(await token.balanceOf(market.address)).is.eq(0)
		expect(await token.balanceOf(client2.address)).is.eq(buy_nominal.sub(exec_nominal).add(second_exec_nominal))
		expect(await token.balanceOf(client3.address)).is.eq(second_buy_nominal.sub(second_exec_nominal))
		expect(await put.balanceOf(client2.address)).is.eq(sell_qty.sub(second_buy_qty))
		expect(await put.balanceOf(client3.address)).is.eq(second_buy_qty)
	})
})
