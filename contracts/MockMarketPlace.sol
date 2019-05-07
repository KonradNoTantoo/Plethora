pragma solidity ^0.5.5;
pragma experimental ABIEncoderV2;


import "Common.sol";


contract MockBookOwner is IBookOwner {
	function on_buy_execution(IBook.Execution calldata execution) external {}
	function on_sell_execution(IBook.Execution calldata execution) external {}

	function buy(IBook book, uint quantity, uint price) external returns(IBook.Status order_status) {
		IBook.Result memory result = book.buy(msg.sender, quantity, price);
		return result.status;
	}

	function sell(IBook book, uint quantity, uint price) external returns(IBook.Status order_status) {
		IBook.Result memory result = book.sell(msg.sender, quantity, price);
		return result.status;
	}

	function cancel(IBook book, bytes32 order_id) external returns(IBook.Order memory order) {
		return book.cancel(msg.sender, order_id);
	}
}
