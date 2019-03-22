const chai = require('chai')
const ethers = require('ethers')
const {createMockProvider, deployContract, getWallets, solidity} = require('ethereum-waffle')

const Plethora = require('../build/Plethora')
const BookFactory = require('../build/BookFactory')
const CallMarketPlace = require('../build/CallMarketPlace')

chai.use(solidity)
const {expect} = chai


function now() { return Math.floor(Date.now()/1000) }
function offset_to_expiry( offset ) { return 1546351200 + offset }
const SECONDS_IN_A_DAY = 60*60*24


describe('CallMarketPlace', function() {
	this.timeout(4000)

	let provider = createMockProvider()
	let [admin, client1, client2] = getWallets(provider)
	let token
	let factory
	let market
	let client1_market
	let client2_market
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

	beforeEach(async () => {
		token = await deployContract(admin, Plethora, [])
		factory = await deployContract(admin, BookFactory, [])
		market = await deployContract(admin, CallMarketPlace, [token.address, factory.address], max_gas)

		await token.mintFor(client1.address, nb_tokens)

		client1_market = market.connect(client1)
		client2_market = market.connect(client2)

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
		const tokenFromClient1 = token.connect(client1)
		await tokenFromClient1.approve(market.address, nominal)
		await client1_market.buy(book_address, qty, px, max_gas)

		expect(await token.balanceOf(client1.address)).is.eq(nb_tokens.sub(nominal))
	})
/*
	it('Place sell order', async () => {
		const qty = q(100)
		const px = p(3)
		await expect(client1_market.sell(book_address, qty, px, max_gas))
			.to.emit(book, 'SellOrder')
		expect(await book.bid_size()).to.eq(1)
		const order_id = await book.bid_order(0, 0)
		const order = await book.get_order(order_id)
		expect(order.quantity).is.eq(qty)
		expect(order.issuer).is.eq(client1.address)
		expect(order.price).is.eq(px)
	})

	it('Place two sell orders at same price', async () => {
		const qty1 = q(100)
		const qty2 = q(100)
		const px = p(3)
		await expect(client1_market.sell(book_address, qty1, px, max_gas))
			.to.emit(book, 'SellOrder')
		await expect(client2_market.sell(book_address, qty2, px, max_gas))
			.to.emit(book, 'SellOrder')
		expect(await book.bid_size()).to.eq(1)

		const [entry_price, nb_entries] = await book.bid_entries(0)
		expect(entry_price).is.eq(px)
		expect(nb_entries).is.eq(2)

		const order1_id = await book.bid_order(0, 0)
		const order1 = await book.get_order(order1_id)
		expect(order1.quantity).is.eq(qty1)
		expect(order1.issuer).is.eq(client1.address)
		expect(order1.price).is.eq(px)
		expect(order1.alive).is.true

		const order2_id = await book.bid_order(0, 1)
		const order2 = await book.get_order(order2_id)
		expect(order2.quantity).is.eq(qty2)
		expect(order2.issuer).is.eq(client2.address)
		expect(order2.price).is.eq(px)
		expect(order2.alive).is.true
	})

	it('Trigger full buy execution', async () => {
		const qty_buy = q(100)
		const qty_sell = q(200)
		await client1_market.sell(book_address, qty_sell, p(2), max_gas)

		expect(await book.bid_size()).to.eq(1)
		expect(await book.ask_size()).to.eq(0)

		const [price, nb_entries] = await book.bid_entries(0)
		expect(price).is.eq(p(2))
		expect(nb_entries).is.eq(1)

		const order_id = await book.bid_order(0, 0)

		await expect(client2_market.buy(book_address, qty_buy, p(3), max_gas))
		 	.to.emit(book, 'Hit')
		 	.withArgs(order_id, client2.address, client1.address, p(2), qty_buy)

		expect(await book.bid_size()).to.eq(1)
		expect(await book.ask_size()).to.eq(0)

		const order = await book.get_order(order_id)
		expect(order.quantity).is.eq(qty_sell.sub(qty_buy))
		expect(order.issuer).is.eq(client1.address)
		expect(order.price).is.eq(p(2))
		expect(order.alive).is.true
	})

	it('Trigger partial buy execution', async () => {
		const qty_sell = q(100)
		const qty_buy = qty_sell.mul(3)
		await client1_market.sell(book_address, qty_sell, p(2), max_gas)
		await client1_market.sell(book_address, qty_sell, p(3), max_gas)

		expect(await book.bid_size()).to.eq(2)
		expect(await book.ask_size()).to.eq(0)

		const order1_id = await book.bid_order(0, 0)
		const order2_id = await book.bid_order(1, 0)

		await expect(client2_market.buy(book_address, qty_buy, p(3), max_gas))
		 	.to.emit(book, 'Hit')
		 	// .withArgs(order1_id, client2.address, client1.address, p(2), qty_sell)
		 	// .to.emit(book, 'Hit')
		 	// .withArgs(order2_id, client2.address, client1.address, p(3), qty_sell)

		expect(await book.bid_size()).to.eq(0)
		expect(await book.ask_size()).to.eq(1)

		const buy_order_id = await book.ask_order(0, 0)
		const order = await book.get_order(buy_order_id)
		expect(order.quantity).is.eq(qty_buy.sub(qty_sell.mul(2)))
		expect(order.issuer).is.eq(client2.address)
		expect(order.price).is.eq(p(3))
		expect(order.alive).is.true
	})

	it('Trigger full sell execution', async () => {
		const qty_buy = q(200)
		const qty_sell = q(100)
		await client1_market.buy(book_address, qty_buy, p(3), max_gas)

		expect(await book.bid_size()).to.eq(0)
		expect(await book.ask_size()).to.eq(1)

		const [price, nb_entries] = await book.ask_entries(0)
		expect(price).is.eq(p(-3))
		expect(nb_entries).is.eq(1)

		const order_id = await book.ask_order(0, 0)

		await expect(client2_market.sell(book_address, qty_sell, p(2), max_gas))
		 	.to.emit(book, 'Hit')
		 	.withArgs(order_id, client1.address, client2.address, p(3), qty_sell)

		expect(await book.bid_size()).to.eq(0)
		expect(await book.ask_size()).to.eq(1)

		const order = await book.get_order(order_id)
		expect(order.quantity).is.eq(qty_buy.sub(qty_sell))
		expect(order.issuer).is.eq(client1.address)
		expect(order.price).is.eq(p(3))
		expect(order.alive).is.true
	})

	it('Forbid cancellation', async () => {
		const qty = q(100)
		const px = p(3)
		await expect(client1_market.buy(book_address, qty, px, max_gas))
			.to.emit(book, 'BuyOrder')
		expect(await book.ask_size()).to.eq(1)
		const order_id = await book.ask_order(0, 0)

		await expect(client2_market.cancel(book_address, order_id))
			.to.be.reverted
	})

	it('Cancel order', async () => {
		const qty = q(100)
		const px = p(3)
		await expect(client1_market.buy(book_address, qty, px, max_gas))
			.to.emit(book, 'BuyOrder')
		expect(await book.ask_size()).to.eq(1)
		const order_id = await book.ask_order(0, 0)

		await expect(client1_market.cancel(book_address, order_id))
			.to.emit(book, "Cancelled")
			.withArgs(order_id)

		const order = await book.get_order(order_id)
		expect(order.alive).is.false
	})

	it('Cancel order and no hit', async () => {
		const qty = q(100)
		const px = p(3)
		await expect(client1_market.buy(book_address, qty, px, max_gas))
			.to.emit(book, 'BuyOrder')
		expect(await book.ask_size()).to.eq(1)
		const order_id = await book.ask_order(0, 0)

		await client1_market.cancel(book_address, order_id)

		const order = await book.get_order(order_id)
		expect(order.alive).is.false

		await expect(client2_market.sell(book_address, qty, px, max_gas))
			.not.to.emit(book, 'Hit')

		expect(await book.ask_size()).to.eq(0) // dead order has been removed
		expect(await book.bid_size()).to.eq(1) // opposite order has been booked
	})
	//*/
})