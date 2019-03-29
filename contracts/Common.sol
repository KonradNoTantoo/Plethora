pragma solidity ^0.5.5;
pragma experimental ABIEncoderV2;


library PriceLib {
	uint constant PRICE_ADJUSTMENT = 16;

	function nominal_value(uint quantity, uint price) internal pure returns(uint nominal) {
		return (quantity*price) >> PRICE_ADJUSTMENT;
	}

	function is_valid_nominal(uint quantity, uint price) internal pure returns(bool is_valid) {
		uint test_overflow = quantity * price;
		return test_overflow >= quantity && test_overflow >= price;
	}
}


interface IBook {
	enum Status { BOOKED, PARTIAL_EXEC, FULL_EXEC }

	struct Order {
		uint time;
		uint quantity;
		uint price;
		bool alive;
		address issuer;
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

	function sell(address issuer, uint quantity, uint price, bytes20 user_data) external returns(Result memory result);

	function buy(address issuer, uint quantity, uint price, bytes20 user_data) external returns(Result memory result);

	function cancel(address issuer, bytes32 order_id) external returns(Order memory order);

	function clear() external;
}


interface IBookFactory {
	function create(
			uint minimum_order_quantity
		,	uint max_order_lifetime
		) external returns(IBook book);
}


interface IMarketPlace {
	function on_buy_execution(bytes20 hit_user_data, bytes20 order_user_data, IBook.Execution calldata execution) external;
	function on_sell_execution(bytes20 hit_user_data, bytes20 order_user_data, IBook.Execution calldata execution) external;
	function on_expired(IBook.Order calldata order) external;
}
