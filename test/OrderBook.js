const chai = require('chai')
const ethers = require('ethers')
const {createMockProvider, deployContract, getWallets, solidity} = require('ethereum-waffle')

const Book = require('../build/Book')
const MockMarketPlace = require('../build/MockMarketPlace')

chai.use(solidity)
const {expect} = chai


describe('Book', function() {
	let provider = createMockProvider()
	let [admin, client1, client2] = getWallets(provider)
	let market
	let client1_market
	let client2_market
	let book
	const minimum_quantity = ethers.utils.parseEther('0.01')
	const tick_size = ethers.utils.parseEther('0.0001')
	const max_order_lifetime = 2 // 2 seconds, for test purposes
	const max_gas = { gasLimit: 5000000 }

	function q(qty) { return minimum_quantity.add(qty) }
	function p(px) { return tick_size.mul(px) }

	beforeEach(async () => {
		market = await deployContract(admin, MockMarketPlace, [])
		book = await deployContract(admin, Book, [market.address, minimum_quantity, tick_size, max_order_lifetime])
		client1_market = market.connect(client1)
		client2_market = market.connect(client2)
	})

	it('Bad constructors', async () => {
		await expect(deployContract(admin, Book, [market.address, 0, tick_size, max_order_lifetime]))
			.to.be.reverted
		await expect(deployContract(admin, Book, [market.address, minimum_quantity, 0, max_order_lifetime]))
			.to.be.reverted
		await expect(deployContract(admin, Book, [market.address, minimum_quantity, tick_size, 0]))
			.to.be.reverted
	})

	it('Bad orders', async () => {
		await expect(client1_market.buy(book.address, 100, p(3), max_gas))
			.to.be.reverted
		await expect(client1_market.buy(book.address, q(100), 3, max_gas))
			.to.be.reverted
		await expect(client1_market.sell(book.address, 100, p(3), max_gas))
			.to.be.reverted
		await expect(client1_market.sell(book.address, q(100), 3, max_gas))
			.to.be.reverted
	})

	it('Place buy order', async () => {
		const qty = q(100)
		const px = p(3)
		await expect(client1_market.buy(book.address, qty, px, max_gas))
			.to.emit(book, 'BuyOrder')
		expect(await book.ask_size()).to.eq(1)
		const order_id = await book.ask_order(0, 0)
		const order = await book.get_order(order_id)
		expect(order.quantity).is.eq(qty)
		expect(order.issuer).is.eq(client1.address)
		expect(order.price).is.eq(px)
	})

	it('Place sell order', async () => {
		const qty = q(100)
		const px = p(3)
		await expect(client1_market.sell(book.address, qty, px, max_gas))
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
		await expect(client1_market.sell(book.address, qty1, px, max_gas))
			.to.emit(book, 'SellOrder')
		await expect(client2_market.sell(book.address, qty2, px, max_gas))
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
		await client1_market.sell(book.address, qty_sell, p(2), max_gas)

		expect(await book.bid_size()).to.eq(1)
		expect(await book.ask_size()).to.eq(0)

		const [price, nb_entries] = await book.bid_entries(0)
		expect(price).is.eq(p(2))
		expect(nb_entries).is.eq(1)

		const order_id = await book.bid_order(0, 0)

		await expect(client2_market.buy(book.address, qty_buy, p(3), max_gas))
		 	.to.emit(book, 'Hit')
		 	.withArgs(order_id, client2.address, client1.address, p(2), qty_buy, '0x0000000000000000000000000000000000000000')

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
		await client1_market.sell(book.address, qty_sell, p(2), max_gas)
		await client1_market.sell(book.address, qty_sell, p(3), max_gas)

		expect(await book.bid_size()).to.eq(2)
		expect(await book.ask_size()).to.eq(0)

		const order1_id = await book.bid_order(0, 0)
		const order2_id = await book.bid_order(1, 0)

		await expect(client2_market.buy(book.address, qty_buy, p(3), max_gas))
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
		await client1_market.buy(book.address, qty_buy, p(3), max_gas)

		expect(await book.bid_size()).to.eq(0)
		expect(await book.ask_size()).to.eq(1)

		const [price, nb_entries] = await book.ask_entries(0)
		expect(price).is.eq(p(-3))
		expect(nb_entries).is.eq(1)

		const order_id = await book.ask_order(0, 0)

		await expect(client2_market.sell(book.address, qty_sell, p(2), max_gas))
		 	.to.emit(book, 'Hit')
		 	.withArgs(order_id, client1.address, client2.address, p(3), qty_sell, '0x0000000000000000000000000000000000000000')

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
		await expect(client1_market.buy(book.address, qty, px, max_gas))
			.to.emit(book, 'BuyOrder')
		expect(await book.ask_size()).to.eq(1)
		const order_id = await book.ask_order(0, 0)

		await expect(client2_market.cancel(book.address, order_id))
			.to.be.reverted
	})

	it('Cancel order', async () => {
		const qty = q(100)
		const px = p(3)
		await expect(client1_market.buy(book.address, qty, px, max_gas))
			.to.emit(book, 'BuyOrder')
		expect(await book.ask_size()).to.eq(1)
		const order_id = await book.ask_order(0, 0)

		await expect(client1_market.cancel(book.address, order_id))
			.to.emit(book, "Cancelled")
			.withArgs(order_id)

		const order = await book.get_order(order_id)
		expect(order.alive).is.false
	})

	it('Cancel order and no hit', async () => {
		const qty = q(100)
		const px = p(3)
		await expect(client1_market.buy(book.address, qty, px, max_gas))
			.to.emit(book, 'BuyOrder')
		expect(await book.ask_size()).to.eq(1)
		const order_id = await book.ask_order(0, 0)

		await client1_market.cancel(book.address, order_id)

		const order = await book.get_order(order_id)
		expect(order.alive).is.false

		await expect(client2_market.sell(book.address, qty, px, max_gas))
			.not.to.emit(book, 'Hit')

		expect(await book.ask_size()).to.eq(0) // dead order has been removed
		expect(await book.bid_size()).to.eq(1) // opposite order has been booked
	})
})