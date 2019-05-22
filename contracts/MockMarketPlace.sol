pragma solidity ^0.5.5;
pragma experimental ABIEncoderV2;


import "Common.sol";
import "OrderBook.sol";


contract MockBook is IOrderBook {
	constructor(uint quantity_unit) public IOrderBook(quantity_unit) {}

	function _on_buy_execution(address buyer, address seller, uint quantity, uint price) internal {}
	function _on_sell_execution(address buyer, address seller, uint quantity, uint price) internal {}

	function buy(uint quantity, uint price) external {
		_buy(quantity, price);
	}

	function sell(uint quantity, uint price) external {
		_sell(quantity, price);
	}

	function cancel(bytes32 order_id) external {
		_cancel(order_id);
	}
}
