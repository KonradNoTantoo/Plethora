pragma solidity ^0.5.5;
pragma experimental ABIEncoderV2;


import "Common.sol";


contract MockBookOwner is IBookOwner {
	function on_buy_execution(address buyer, address seller, uint quantity, uint price) external {}
	function on_sell_execution(address buyer, address seller, uint quantity, uint price) external {}

	function buy(IBook book, uint quantity, uint price) external returns(uint) {
		return book.buy(msg.sender, quantity, price);
	}

	function sell(IBook book, uint quantity, uint price) external returns(uint) {
		return book.sell(msg.sender, quantity, price);
	}

	function cancel(IBook book, bytes32 order_id) external returns(IBook.Order memory order) {
		return book.cancel(msg.sender, order_id);
	}
}
