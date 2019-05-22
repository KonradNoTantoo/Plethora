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
