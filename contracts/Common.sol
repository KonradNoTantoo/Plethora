pragma solidity ^0.5.5;
pragma experimental ABIEncoderV2;


library PriceLib {
	uint constant PRICE_ADJUSTMENT = 3;

	function nominal_value(uint quantity, uint price) internal pure returns(uint nominal) {
		return (quantity*price) >> PRICE_ADJUSTMENT;
	}

	function is_valid_nominal(uint quantity, uint price) internal pure returns(bool is_valid) {
		uint test_overflow = quantity * price;
		return test_overflow >= quantity && test_overflow >= price;
	}
}


interface IBook {
	struct Order {
		uint quantity;
		uint price;
		address issuer;
		uint128 alive;
		uint128 is_buy;
	}

	struct Execution {
		uint price;
		uint quantity;
		address buyer;
		address seller;
	}

	function sell(address issuer, uint quantity, uint price) external returns(uint remaining_quantity);

	function buy(address issuer, uint quantity, uint price) external returns(uint remaining_quantity);

	function cancel(address issuer, bytes32 order_id) external returns(Order memory order);

	function clear() external;
}


interface IBookFactory {
	function create(uint order_quantity_unit) external returns(IBook book);
}


interface IBookOwner {
	function on_buy_execution(address buyer, address seller, uint quantity, uint price) external;
	function on_sell_execution(address buyer, address seller, uint quantity, uint price) external;
}
