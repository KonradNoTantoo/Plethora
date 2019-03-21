pragma solidity ^0.5.5;
pragma experimental ABIEncoderV2;


interface IBook {
	enum Status { BOOKED, PARTIAL_EXEC, FULL_EXEC }

	struct Order {
		uint time;
		uint quantity;
		uint32 price;
		address issuer;
		bool alive;
		bytes20 user_data;
	}

	struct Result {
		Status status;
		Order order;
	}

	struct Execution {
		uint time;
		uint price;
		uint quantity;
		address buyer;
		address seller;
	}

	function last_execution() external view returns(Execution memory last);

	function get_order(bytes32 order_id) external view returns(Order memory gotten);

	function sell(address issuer, uint quantity, uint32 price) external returns(Result memory result);

	function buy(address issuer, uint quantity, uint32 price) external returns(Result memory result);

	function cancel(address issuer, bytes32 order_id) external returns(Order memory order);

	function clear() external;
}

interface IBookFactory {
	function create(
			uint minimum_order_quantity
		,	uint price_tick_size
		,	uint max_order_lifetime
		) external returns(IBook book);
}


interface IMarketPlace {
	function on_buy_execution(bytes20 user_data) external;
	function on_sell_execution(bytes20 user_data) external;
	function on_expired(IBook.Order calldata order) external;
	function get_user_data() external returns(bytes20 user_data);
}
