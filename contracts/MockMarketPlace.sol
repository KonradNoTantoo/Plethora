pragma solidity ^0.5.5;
pragma experimental ABIEncoderV2;


import "Common.sol";


contract MockMarketPlace is IMarketPlace {
	function on_buy_execution(bytes20 hit_user_data, bytes20 order_user_data, IBook.Execution calldata execution) external {}
	function on_sell_execution(bytes20 hit_user_data, bytes20 order_user_data, IBook.Execution calldata execution) external {}
	function on_expired(IBook.Order calldata order) external {}

	function buy(address book_address, uint quantity, uint price) external returns(IBook.Status order_status) {
		IBook book = IBook(book_address);
		IBook.Result memory result = book.buy(msg.sender, quantity, price, bytes20(0));
		return result.status;
	}

	function sell(address book_address, uint quantity, uint price) external returns(IBook.Status order_status) {
		IBook book = IBook(book_address);
		IBook.Result memory result = book.sell(msg.sender, quantity, price, bytes20(0));
		return result.status;
	}

	function cancel(address book_address, bytes32 order_id) external returns(IBook.Order memory order) {
		IBook book = IBook(book_address);
		return book.cancel(msg.sender, order_id);
	}
}
