const chai = require('chai');
const {createMockProvider, deployContract, getWallets, solidity} = require('ethereum-waffle');

const CoveredEthCall = require('../build/CoveredEthCall');
const CoveredEthPut = require('../build/CoveredEthPut');

/*import BasicTokenMock from './build/BasicTokenMock';
import MyLibrary from './build/MyLibrary';
import LibraryConsumer from './build/LibraryConsumer';*/

chai.use(solidity);
const {expect} = chai;


describe('CoveredEthCall', () => {
	let provider = createMockProvider();
	let [wallet, walletTo] = getWallets(provider);
	let token;

	beforeEach(async () => {
		token = await deployContract(wallet, CoveredEthCall, [wallet.address, 1000]);
	});

	it('Assigns initial balance', async () => {
		expect(await token.balanceOf(wallet.address)).to.eq(1000);
	});
}
