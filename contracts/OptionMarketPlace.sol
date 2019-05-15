pragma solidity ^0.5.5;
pragma experimental ABIEncoderV2;


import "CoveredOption.sol";


contract CoveredEthCallBook is CoveredEthCall, IBookOwner {
	IBook public _book;

	constructor(
			IERC20 erc20_minter
		,	uint strike_per_underlying_unit
		,	uint expiry
		,	IBookFactory factory
		,	uint order_quantity_unit
		) public
		CoveredEthCall(erc20_minter, strike_per_underlying_unit, expiry)
	{
		_book = factory.create(order_quantity_unit);
	}

	function buy(uint quantity, uint price) external {
		require( false == _is_expired() );

		uint remaining_quantity = _book.buy(msg.sender, quantity, price);

		if ( remaining_quantity > 0 )
		{
			_erc20_minter.transferFrom(msg.sender, address(this),
				PriceLib.nominal_value(remaining_quantity, price));
		}
	}

	function sell(uint quantity, uint price) external payable {
		require( false == _is_expired() );

		uint free_quantity = _nominal_shares[msg.sender] - _locked_shares[msg.sender];

		if ( free_quantity < quantity )
		{
			uint missing_quantity = quantity - free_quantity;
			require( msg.value == missing_quantity );
			_emit_shares_for_self(msg.sender, missing_quantity);
		}

		_lock(msg.sender, quantity);
		_book.sell(msg.sender, quantity, price);
	}

	function on_buy_execution(address buyer, address seller, uint quantity, uint price) external {
		require( msg.sender == address(_book) );
		_transfer_locked(seller, buyer, quantity);
		_erc20_minter.transferFrom(buyer, seller,
			PriceLib.nominal_value(quantity, price));
	}

	function on_sell_execution(address buyer, address seller, uint quantity, uint price) external {
		require( msg.sender == address(_book) );
		_transfer_locked(seller, buyer, quantity);
		_erc20_minter.transfer(seller,
			PriceLib.nominal_value(quantity, price));
	}

	function cancel(bytes32 order_id) external {
		IBook.Order memory order = _book.cancel(msg.sender, order_id);

		if( order.is_buy != 0 )
		{
			_erc20_minter.transfer(msg.sender,
				PriceLib.nominal_value(order.quantity, order.price));
		}
		else
		{
			_unlock(msg.sender, order.quantity);
		}
	}

	function liquidate(address payable liquidator) external {
		_book.clear();
		_liquidate(liquidator);
	}
}


contract CoveredEthPutBook is CoveredEthCall, IBookOwner
{
	IBook public _book;

	constructor(
			IERC20 erc20_minter
		,	uint strike_per_underlying_unit
		,	uint expiry
		,	IBookFactory factory
		,	uint order_quantity_unit
		) public
		CoveredEthCall(erc20_minter, strike_per_underlying_unit, expiry)
	{
		_book = factory.create(order_quantity_unit);
	}

	function buy(uint quantity, uint price) external {
		require( false == _is_expired() );

		uint remaining_quantity = _book.buy(msg.sender, quantity, price);

		if ( remaining_quantity > 0 )
		{
			_erc20_minter.transferFrom(msg.sender, address(this),
				PriceLib.nominal_value(remaining_quantity, price));
		}
	}

	function sell(uint quantity, uint price) external {
		require( false == _is_expired() );

		uint free_quantity = _nominal_shares[msg.sender] - _locked_shares[msg.sender];

		if ( free_quantity < quantity )
		{
			uint missing_quantity = quantity - free_quantity;
			_erc20_minter.transferFrom(msg.sender, address(this),
				PriceLib.nominal_value(missing_quantity, _strike_per_underlying_unit));
			_emit_shares_for_self(msg.sender, missing_quantity);
		}

		_lock(msg.sender, quantity);
		_book.sell(msg.sender, quantity, price);
	}

	function on_buy_execution(address buyer, address seller, uint quantity, uint price) external {
		require( msg.sender == address(_book) );
		_transfer_locked(seller, buyer, quantity);
		_erc20_minter.transferFrom(buyer, seller,
			PriceLib.nominal_value(quantity, price));
	}

	function on_sell_execution(address buyer, address seller, uint quantity, uint price) external {
		require( msg.sender == address(_book) );
		_transfer_locked(seller, buyer, quantity);
		_erc20_minter.transfer(seller,
			PriceLib.nominal_value(quantity, price));
	}

	function cancel(bytes32 order_id) external {
		IBook.Order memory order = _book.cancel(msg.sender, order_id);

		if( order.is_buy != 0 )
		{
			_erc20_minter.transfer(msg.sender,
				PriceLib.nominal_value(order.quantity, order.price));
		}
		else
		{
			_unlock(msg.sender, order.quantity);
		}
	}

	function liquidate(address payable liquidator) external {
		_book.clear();
		_liquidate(liquidator);
	}
}


contract OptionMarketPlace {
	event BookOpened(address book_address, uint expiry, uint strike);
	event BookClosed(address book_address);

	uint constant MINIMUM_TRADING_TIME = 1 days;
	uint constant BOOK_OPENING_FEE = 10 finney;

	IERC20 public _pricing_token_vault;
	IBookFactory public _book_factory;

	// strike => expiry => address
	mapping(uint => mapping(uint => address)) public _books;
	address[] public _book_addresses;

	constructor(address pricing_token_vault, address book_factory) public {
		_pricing_token_vault = IERC20(pricing_token_vault);
		_book_factory = IBookFactory(book_factory);
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
	constructor(address pricing_token_vault, address book_factory) public
		OptionMarketPlace(pricing_token_vault, book_factory) {}

	function open_book(uint expiry, uint strike_per_underlying_unit, uint order_quantity_unit) external payable {
		require( msg.value == BOOK_OPENING_FEE );
		_open_book(
				expiry
			,	strike_per_underlying_unit
			,	new CoveredEthCallBook(
					_pricing_token_vault
				,	strike_per_underlying_unit
				,	expiry
				,	_book_factory
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
	constructor(address pricing_token_vault, address book_factory) public
		OptionMarketPlace(pricing_token_vault, book_factory) {}

	function open_book(uint expiry, uint strike_per_underlying_unit, uint order_quantity_unit) external payable {
		require( msg.value == BOOK_OPENING_FEE );
		_open_book(
				expiry
			,	strike_per_underlying_unit
			,	new CoveredEthPutBook(
					_pricing_token_vault
				,	strike_per_underlying_unit
				,	expiry
				,	_book_factory
				,	order_quantity_unit
			)
		);
	}

	function close_book(uint expiry, uint strike_per_underlying_unit) external {
		address closed_book = _close_book(expiry, strike_per_underlying_unit);
		CoveredEthPutBook(closed_book).liquidate(msg.sender);
	}
}
