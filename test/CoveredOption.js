const chai = require('chai')
const ethers = require('ethers')
const {createMockProvider, deployContract, getWallets, solidity} = require('ethereum-waffle')

const Plethora = require('../build/Plethora')
const CoveredEthCall = require('../build/CoveredEthCall')
const CoveredEthPut = require('../build/CoveredEthPut')

chai.use(solidity)
const {expect} = chai


function now() { return Math.floor(Date.now()/1000) }
function next_minute() { return now() + 60 }
function in_two_seconds() { return now() + 2 }
const PRICE_ADJUSTMENT = 2**3
function adjust_price(p) { return p*PRICE_ADJUSTMENT }

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}


describe('CoveredEthCall', function() {
	let provider = createMockProvider()
	let [admin, client1, client2, writer1] = getWallets(provider)
	let token
	let call
	let callFromClient1
	const underlying_nominal = ethers.utils.parseEther('1.0')
	const strike = 100.125
	const nb_tokens = underlying_nominal.mul(adjust_price(strike)).div(PRICE_ADJUSTMENT)
	const MAX_GAS = 5000000
	const max_gas = { gasLimit: MAX_GAS }

	beforeEach(async () => {
		token = await deployContract(admin, Plethora, [])
		call = await deployContract(admin, CoveredEthCall, [token.address, adjust_price(strike), in_two_seconds()], max_gas)

		await token.mintFor(client1.address, nb_tokens)

		const override = {
			gasLimit: MAX_GAS,
			value: underlying_nominal
		}

		await call.emit_shares(writer1.address, client1.address, override)
		callFromClient1 = call.connect(client1)
	})

	it('Bad constructors', async () => {
		await expect(deployContract(admin, CoveredEthCall, [token.address, 0, next_minute()]))
			.to.be.reverted
		await expect(deployContract(admin, CoveredEthCall, [token.address, adjust_price(strike), now() - 60]))
			.to.be.reverted
	})

	it('Initial balance', async () => {
		expect(await call.balanceOf(client1.address)).to.eq(underlying_nominal)
		expect(await call.balanceOf(writer1.address)).to.eq(0)
		expect(await call._strike_per_underlying_unit()).to.eq(adjust_price(strike))
		expect(await token.balanceOf(client1.address)).to.eq(nb_tokens)
		expect(await provider.getBalance(call.address)).to.eq(underlying_nominal)
	})

	it('Transfer adds amount to destination account', async () => {
		await callFromClient1.transfer(client2.address, 7)
		expect(await call.balanceOf(client1.address)).to.eq(underlying_nominal.sub(7))
		expect(await call.balanceOf(client2.address)).to.eq(7)
	})

	it('Transfer emits event', async () => {
		await expect(callFromClient1.transfer(client2.address, 7))
			.to.emit(call, 'Transfer')
			.withArgs(client1.address, client2.address, 7)
	})

	it('TransferFrom emits event', async () => {
		await callFromClient1.approve(admin.address, 7)
		await expect(call.transferFrom(client1.address, client2.address, 7))
			.to.emit(call, 'Transfer')
			.withArgs(client1.address, client2.address, 7)
	})

	it('Can not transfer above the amount', async () => {
		await expect(call.transfer(client2.address, underlying_nominal + 1)).to.be.reverted
	})

	it('Can not transfer from empty account', async () => {
		const callFromOtherWallet = call.connect(client2);
		await expect(callFromOtherWallet.transfer(client1.address, 1))
			.to.be.reverted;
	});

	it('Exercise', async () => {
		await expect(callFromClient1.call(underlying_nominal)).to.be.reverted // not yet expired
		await sleep(2100)
		expect(await call._expiry()).to.be.at.most(now())
		await expect(callFromClient1.call(underlying_nominal)).to.be.reverted // expired but no approval
		const tokenFromClient1 = token.connect(client1)
		await tokenFromClient1.approve(call.address, nb_tokens)
		await callFromClient1.call(underlying_nominal)
		// TODO line below doesn't work
		// await expect(() => callFromClient1.call(underlying_nominal))
		//  	.to.changeBalance(client1, underlying_nominal)
		expect(await token.balanceOf(call.address)).to.eq(nb_tokens)
		expect(await token.balanceOf(client1.address)).to.eq(0)
		expect(await call.balanceOf(client1.address)).to.eq(0)
	})
})


describe('CoveredEthPut', function() {
	let provider = createMockProvider()
	let [admin, client1, client2, writer1] = getWallets(provider)
	let token
	let put
	let putFromClient1
	const underlying_nominal = ethers.utils.parseEther('1.0')
	const strike = 100.250
	const nb_tokens = underlying_nominal.mul(adjust_price(strike)).div(PRICE_ADJUSTMENT)
	const MAX_GAS = 5000000
	const max_gas = { gasLimit: MAX_GAS }

	beforeEach(async () => {
		token = await deployContract(admin, Plethora, [])
		put = await deployContract(admin, CoveredEthPut, [token.address, adjust_price(strike), in_two_seconds()], max_gas)

		await token.mintFor(writer1.address, nb_tokens)

		const tokenFromWriter1 = token.connect(writer1)
		await tokenFromWriter1.approve(put.address, nb_tokens)
		putFromClient1 = put.connect(client1)
		const putFromWriter1 = put.connect(writer1)
		await putFromWriter1.emit_shares(writer1.address, client1.address, underlying_nominal)
	})

	it('Bad constructors', async () => {
		await expect(deployContract(admin, CoveredEthPut, [token.address, 0, next_minute()]))
			.to.be.reverted
		await expect(deployContract(admin, CoveredEthPut, [token.address, adjust_price(strike), now() - 60]))
			.to.be.reverted
	})

	it('Initial balance', async () => {
		expect(await put.balanceOf(client1.address)).to.eq(underlying_nominal)
		expect(await put.balanceOf(writer1.address)).to.eq(0)
		expect(await put._strike_per_underlying_unit()).to.eq(adjust_price(strike))
		expect(await token.balanceOf(writer1.address)).to.eq(0)
		expect(await token.balanceOf(put.address)).to.eq(nb_tokens)
	})

	it('Transfer adds amount to destination account', async () => {
		await putFromClient1.transfer(client2.address, 7)
		expect(await put.balanceOf(client1.address)).to.eq(underlying_nominal.sub(7))
		expect(await put.balanceOf(client2.address)).to.eq(7)
	})

	it('Transfer emits event', async () => {
		await expect(putFromClient1.transfer(client2.address, 7))
			.to.emit(put, 'Transfer')
			.withArgs(client1.address, client2.address, 7)
	})

	it('TransferFrom emits event', async () => {
		await putFromClient1.approve(admin.address, 7)
		await expect(put.transferFrom(client1.address, client2.address, 7))
			.to.emit(put, 'Transfer')
			.withArgs(client1.address, client2.address, 7)
	})

	it('Can not transfer above the amount', async () => {
		await expect(put.transfer(client2.address, underlying_nominal + 1)).to.be.reverted
	})

	it('Can not transfer from empty account', async () => {
		const putFromOtherWallet = put.connect(client2);
		await expect(putFromOtherWallet.transfer(client1.address, 1))
			.to.be.reverted;
	});

	it('Exercise', async () => {
		const override = {
			gasLimit: 1000000,
			value: underlying_nominal
		}
		await expect(putFromClient1.put(override)).to.be.reverted // not yet expired
		await sleep(2100)
		expect(await put._expiry()).to.be.at.most(now())
		await putFromClient1.put(override)
		expect(await token.balanceOf(client1.address)).to.eq(nb_tokens)
		expect(await put.balanceOf(client1.address)).to.eq(0)
		expect(await provider.getBalance(put.address)).to.eq(underlying_nominal)
	})
})
