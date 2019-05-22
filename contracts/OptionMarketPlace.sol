pragma solidity ^0.5.5;
pragma experimental ABIEncoderV2;


import "CoveredOption.sol";
import "OrderBook.sol";


contract CoveredEthCallBook is CoveredEthCall, IOrderBook {
	constructor(
			IERC20 erc20_minter
		,	uint strike_per_underlying_unit
		,	uint expiry
		,	uint order_quantity_unit
		) public
		CoveredEthCall(erc20_minter, strike_per_underlying_unit, expiry)
		IOrderBook(order_quantity_unit)
	{
	}

	function buy(uint quantity, uint price) external {
		require( false == _is_expired() );

		uint remaining_quantity = _buy(quantity, price);

		if ( remaining_quantity > 0 )
		{
			_erc20_minter.transferFrom(msg.sender, address(this),
				PriceLib.nominal_value(remaining_quantity, price));
		}

		if ( remaining_quantity != quantity )
		{
			_cross_call_shares(msg.sender);
		}
	}

	function sell(uint quantity, uint price) external payable {
		require( false == _is_expired() );

		uint free_quantity = _nominal_shares[msg.sender] - _locked_shares[msg.sender];

		if ( free_quantity < quantity )
		{
			require( msg.value == quantity - free_quantity );
			_lock(msg.sender, free_quantity);
		}
		else
		{
			_lock(msg.sender, quantity);
		}

		uint remaining_quantity = _sell(quantity, price);

		if ( remaining_quantity != quantity )
		{
			_cross_call_shares(msg.sender);
		}
	}

	function _on_buy_execution(address buyer, address seller, uint quantity, uint price) internal {
		uint locked_quantity = _locked_shares[seller];

		if ( locked_quantity >= quantity )
		{
			_transfer_locked(seller, buyer, quantity);
		}
		else
		{
			_emit_shares(seller, buyer, quantity - locked_quantity);
			_transfer_locked(seller, buyer, locked_quantity);
			// crossing here engenders vulnerability, if seller has a
			// malicious anynonymous paiement method
			// _cross_call_shares(seller);
		}

		_erc20_minter.transferFrom(buyer, seller,
			PriceLib.nominal_value(quantity, price));
	}

	function _on_sell_execution(address buyer, address seller, uint quantity, uint price) internal {
		uint locked_quantity = _locked_shares[seller];

		if ( locked_quantity >= quantity )
		{
			_transfer_locked(seller, buyer, quantity);
		}
		else
		{
			_emit_shares(seller, buyer, quantity - locked_quantity);
			_transfer_locked(seller, buyer, locked_quantity);
		}

		// crossing here engenders vulnerability, if buyer has a
		// malicious anynonymous paiement method
		// _cross_call_shares(buyer);

		_erc20_minter.transfer(seller,
			PriceLib.nominal_value(quantity, price));
	}

	function cancel(bytes32 order_id) external {
		IOrderBook.Order memory order = _cancel(order_id);

		if( order.is_buy != 0 )
		{
			_erc20_minter.transfer(msg.sender,
				PriceLib.nominal_value(order.quantity, order.price));
		}
		else
		{
			uint locked_quantity = _locked_shares[msg.sender];

			if ( locked_quantity >= order.quantity )
			{
				_unlock(msg.sender, order.quantity);
			}
			else
			{
				_unlock(msg.sender, locked_quantity);
				msg.sender.transfer(order.quantity - locked_quantity);
			}
		}
	}

	function liquidate(address payable liquidator) external {
		_clear();
		_liquidate(liquidator);
	}
}


contract CoveredEthPutBook is CoveredEthPut, IOrderBook
{
	constructor(
			IERC20 erc20_minter
		,	uint strike_per_underlying_unit
		,	uint expiry
		,	uint order_quantity_unit
		) public
		CoveredEthPut(erc20_minter, strike_per_underlying_unit, expiry)
		IOrderBook(order_quantity_unit)
	{
	}

	function buy(uint quantity, uint price) external {
		require( false == _is_expired() );

		uint remaining_quantity = _buy(quantity, price);

		if ( remaining_quantity > 0 )
		{
			_erc20_minter.transferFrom(msg.sender, address(this),
				PriceLib.nominal_value(remaining_quantity, price));
		}

		if ( remaining_quantity != quantity )
		{
			_cross_put_shares(msg.sender);
		}
	}

	function sell(uint quantity, uint price) external {
		require( false == _is_expired() );

		uint free_quantity = _nominal_shares[msg.sender] - _locked_shares[msg.sender];

		if ( free_quantity < quantity )
		{
			_erc20_minter.transferFrom(msg.sender, address(this),
				PriceLib.nominal_value(quantity - free_quantity, _strike_per_underlying_unit));
			_lock(msg.sender, free_quantity);
		}
		else
		{
			_lock(msg.sender, quantity);
		}

		uint remaining_quantity = _sell(quantity, price);

		if ( remaining_quantity != quantity )
		{
			_cross_put_shares(msg.sender);
		}
	}

	function _on_buy_execution(address buyer, address seller, uint quantity, uint price) internal {
		uint locked_quantity = _locked_shares[seller];

		if ( locked_quantity >= quantity )
		{
			_transfer_locked(seller, buyer, quantity);
		}
		else
		{
			_emit_shares(seller, buyer, quantity - locked_quantity);
			_transfer_locked(seller, buyer, locked_quantity);
			_cross_put_shares(seller);
		}

		_erc20_minter.transferFrom(buyer, seller,
			PriceLib.nominal_value(quantity, price));
	}

	function _on_sell_execution(address buyer, address seller, uint quantity, uint price) internal {
		uint locked_quantity = _locked_shares[seller];

		if ( locked_quantity >= quantity )
		{
			_transfer_locked(seller, buyer, quantity);
		}
		else
		{
			_emit_shares(seller, buyer, quantity - locked_quantity);
			_transfer_locked(seller, buyer, locked_quantity);
		}

		_cross_put_shares(buyer);

		_erc20_minter.transfer(seller,
			PriceLib.nominal_value(quantity, price));
	}

	function cancel(bytes32 order_id) external {
		IOrderBook.Order memory order = _cancel(order_id);

		if( order.is_buy != 0 )
		{
			_erc20_minter.transfer(msg.sender,
				PriceLib.nominal_value(order.quantity, order.price));
		}
		else
		{
			uint locked_quantity = _locked_shares[msg.sender];

			if ( locked_quantity >= order.quantity )
			{
				_unlock(msg.sender, order.quantity);
			}
			else
			{
				_unlock(msg.sender, locked_quantity);
				_erc20_minter.transfer(msg.sender,
					PriceLib.nominal_value(order.quantity - locked_quantity, _strike_per_underlying_unit));
			}
		}
	}

	function liquidate(address payable liquidator) external {
		_clear();
		_liquidate(liquidator);
	}
}


contract OptionMarketPlace {
	event BookOpened(address book_address, uint expiry, uint strike);
	event BookClosed(address book_address);

	uint constant MINIMUM_TRADING_TIME = 1 days;
	uint constant BOOK_OPENING_FEE = 10 finney;

	IERC20 public _pricing_token_vault;

	// strike => expiry => address
	mapping(uint => mapping(uint => address)) public _books;
	address[] public _book_addresses;

	constructor(address pricing_token_vault) public {
		_pricing_token_vault = IERC20(pricing_token_vault);
	}

	function get_book_address(uint expiry, uint strike_per_underlying_unit) external view returns(address book) {
		return address(_books[strike_per_underlying_unit][expiry]);
	}

	function nb_books() external view returns(uint number_of_options) {
		return _book_addresses.length;
	}

	function _open_book(uint expiry, uint strike_per_underlying_unit, SmartOptionEthVsERC20 option) internal {
		require(
				address(0) == _books[strike_per_underlying_unit][expiry]
			&&	expiry >= (now + MINIMUM_TRADING_TIME)
			);

		_books[strike_per_underlying_unit][expiry] = address(option);
		_book_addresses.push( address(option) );
		emit BookOpened(address(option), expiry, strike_per_underlying_unit);
	}

	function _close_book(uint expiry, uint strike_per_underlying_unit) internal returns(address book) {
		address book_address = _books[strike_per_underlying_unit][expiry];
		require( address(0) != book_address );

		delete _books[strike_per_underlying_unit][expiry];
		msg.sender.transfer(BOOK_OPENING_FEE);
		emit BookClosed(book_address);
		return book_address;
	}
}


contract CallMarketPlace is OptionMarketPlace {
	constructor(address pricing_token_vault) public OptionMarketPlace(pricing_token_vault) {}

	function open_book(uint expiry, uint strike_per_underlying_unit, uint order_quantity_unit) external payable {
		require( msg.value == BOOK_OPENING_FEE );
		_open_book(
				expiry
			,	strike_per_underlying_unit
			,	new CoveredEthCallBook(
					_pricing_token_vault
				,	strike_per_underlying_unit
				,	expiry
				,	order_quantity_unit
			)
		);
	}

	function close_book(uint expiry, uint strike_per_underlying_unit) external {
		address closed_book = _close_book(expiry, strike_per_underlying_unit);
		CoveredEthCallBook(closed_book).liquidate(msg.sender);
	}
}


contract PutMarketPlace is OptionMarketPlace {
	constructor(address pricing_token_vault) public OptionMarketPlace(pricing_token_vault) {}

	function open_book(uint expiry, uint strike_per_underlying_unit, uint order_quantity_unit) external payable {
		require( msg.value == BOOK_OPENING_FEE );
		_open_book(
				expiry
			,	strike_per_underlying_unit
			,	new CoveredEthPutBook(
					_pricing_token_vault
				,	strike_per_underlying_unit
				,	expiry
				,	order_quantity_unit
			)
		);
	}

	function close_book(uint expiry, uint strike_per_underlying_unit) external {
		address closed_book = _close_book(expiry, strike_per_underlying_unit);
		CoveredEthPutBook(closed_book).liquidate(msg.sender);
	}
}
