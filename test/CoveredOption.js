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
function in_one_second() { return now() + 1 }
const PRICE_ADJUSTMENT = 2**8
function adjust_price(p) { return Math.floor(p*PRICE_ADJUSTMENT) }

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}


describe('CoveredEthCall', function() {
	this.timeout(3000)

	let provider = createMockProvider()
	let [admin, client1, client2, writer1] = getWallets(provider)
	let token
	let call
	const underlying_nominal = ethers.utils.parseEther('1.0')
	const strike = 100.1
	const nb_tokens = underlying_nominal.mul(adjust_price(strike)).div(PRICE_ADJUSTMENT)

	beforeEach(async () => {
		token = await deployContract(admin, Plethora, [])
		await token.mintFor(client1.address, nb_tokens)

		const override = {
			gasLimit: 5000000,
			value: underlying_nominal
		}

		call = await deployContract(admin, CoveredEthCall, [token.address, adjust_price(strike), in_one_second(), client1.address, writer1.address], override)
	})

	it('Bad constructors', async () => {
		const override = {
			value: underlying_nominal
		}

		await expect(deployContract(admin, CoveredEthCall, [token.address, 0, next_minute(), client1.address, writer1.address], override))
			.to.be.reverted
		await expect(deployContract(admin, CoveredEthCall, [token.address, adjust_price(strike), now() - 60, client1.address, writer1.address], override))
			.to.be.reverted
		await expect(deployContract(admin, CoveredEthCall, [token.address, adjust_price(strike), next_minute(), client1.address, writer1.address]))
			.to.be.reverted
	})

	it('Initial balance', async () => {
		expect(await call.balanceOf(client1.address)).to.eq(underlying_nominal)
		expect(await call.balanceOf(writer1.address)).to.eq(0)
		expect(await call._strike_per_underlying_unit()).to.eq(adjust_price(strike))
		expect(await token.balanceOf(client1.address)).to.eq(nb_tokens)
	})

	it('Transfer adds amount to destination account', async () => {
		const callFromClient1 = call.connect(client1)
		await callFromClient1.transfer(client2.address, 7)
		expect(await call.balanceOf(client1.address)).to.eq(underlying_nominal.sub(7))
		expect(await call.balanceOf(client2.address)).to.eq(7)
	})

	it('Admin can always transfer', async () => {
		await call.transferFrom(client1.address, client2.address, 7)
		expect(await call.balanceOf(client1.address)).to.eq(underlying_nominal.sub(7))
		expect(await call.balanceOf(client2.address)).to.eq(7)
	})

	it('Transfer emits event', async () => {
		const callFromClient1 = call.connect(client1)
		await expect(callFromClient1.transfer(client2.address, 7))
			.to.emit(call, 'Transfer')
			.withArgs(client1.address, client2.address, 7)
	})

	it('TransferFrom emits event', async () => {
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
		await expect(call.call(client1.address, underlying_nominal)).to.be.reverted // not yet expired
		await sleep(1100)
		expect(await call._expiry()).to.at.most(now())
		await expect(call.call(client1.address, underlying_nominal)).to.be.reverted // expired but no approval
		const tokenFromClient1 = token.connect(client1)
		await tokenFromClient1.approve(call.address, nb_tokens)
		const override = {
			gasLimit: 5000000
		}
		await expect(() => call.call(client1.address, underlying_nominal, override))
			.to.changeBalance(client1, underlying_nominal)
		expect(await token.balanceOf(call.address)).to.eq(nb_tokens)
		expect(await token.balanceOf(client1.address)).to.eq(0)
		expect(await call.balanceOf(client1.address)).to.eq(0)
	})
})


describe('CoveredEthPut', function() {
	this.timeout(3000)

	let provider = createMockProvider()
	let [admin, client1, client2, writer1] = getWallets(provider)
	let token
	let put
	const underlying_nominal = ethers.utils.parseEther('1.0')
	const strike = 100.2
	const nb_tokens = underlying_nominal.mul(adjust_price(strike)).div(PRICE_ADJUSTMENT)

	beforeEach(async () => {
		token = await deployContract(admin, Plethora, [])
		await token.mintFor(writer1.address, nb_tokens)

		const override = {
			gasLimit: 5000000
		}

		put = await deployContract(admin, CoveredEthPut, [token.address, underlying_nominal, adjust_price(strike), in_one_second(), client1.address, writer1.address], override)

		const tokenFromWriter1 = token.connect(writer1)
		await tokenFromWriter1.transfer(put.address, nb_tokens)
		await put.activate()
	})

	it('Bad constructors', async () => {
		await expect(deployContract(admin, CoveredEthPut, [token.address, underlying_nominal, 0, next_minute(), client1.address, writer1.address]))
			.to.be.reverted
		await expect(deployContract(admin, CoveredEthPut, [token.address, underlying_nominal, adjust_price(strike), now() - 60, client1.address, writer1.address]))
			.to.be.reverted
		await expect(deployContract(admin, CoveredEthPut, [token.address, 0, adjust_price(strike), next_minute(), client1.address, writer1.address]))
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
		const putFromClient1 = put.connect(client1)
		await putFromClient1.transfer(client2.address, 7)
		expect(await put.balanceOf(client1.address)).to.eq(underlying_nominal.sub(7))
		expect(await put.balanceOf(client2.address)).to.eq(7)
	})

	it('Admin can always transfer', async () => {
		await put.transferFrom(client1.address, client2.address, 7)
		expect(await put.balanceOf(client1.address)).to.eq(underlying_nominal.sub(7))
		expect(await put.balanceOf(client2.address)).to.eq(7)
	})

	it('Transfer emits event', async () => {
		const putFromClient1 = put.connect(client1)
		await expect(putFromClient1.transfer(client2.address, 7))
			.to.emit(put, 'Transfer')
			.withArgs(client1.address, client2.address, 7)
	})

	it('TransferFrom emits event', async () => {
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
		await expect(put.put(client1.address, override)).to.be.reverted // not yet expired
		await sleep(1100)
		expect(await put._expiry()).to.at.most(now())
		await put.put(client1.address, override)
		// TODO find a way to check balance of put contract
		expect(await token.balanceOf(client1.address)).to.eq(nb_tokens)
		expect(await put.balanceOf(client1.address)).to.eq(0)
	})
})
