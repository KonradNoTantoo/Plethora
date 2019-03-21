pragma solidity ^0.5.5;
pragma experimental ABIEncoderV2;


import "./CoveredOption.sol";
import "./Interfaces.sol";


contract OptionMarketPlace is IMarketPlace {
	enum OptionType { CALL, PUT }
	event BookOpened(address book_address, OptionType option_type, uint expiry, uint strike);
	event BookClosed(address book_address);

	uint constant EXPIRY_ORIGIN_TIME = 1546351200; // January 1st 2019, 14:00
	uint constant MINIMUM_TRADING_TIME = 1 days;
	uint constant MINIMUM_ORDER_LIFETIME = 1 days;
	uint constant BOOK_OPENING_FEE = 1 finney;
	uint constant BOOK_CLOSE_DELAY = 100 days;

	function to_expiry_offset(uint expiry_timestamp) external pure returns(uint offset) {
		require(expiry_timestamp > EXPIRY_ORIGIN_TIME);
		return expiry_timestamp - EXPIRY_ORIGIN_TIME;
	}

	function require_valid_expiry_offset(uint offset) public view returns(uint expiry_timestamp) {
		uint expiry = offset + EXPIRY_ORIGIN_TIME;
		require(expiry >= (now + MINIMUM_TRADING_TIME) && (offset % 1 days) == 0);
		return expiry;
	}

	IERC20 public _pricing_token_vault;
	IBookFactory public _book_factory; 
	address private _current_order_book;
	address private _current_option_contract;

	struct BookData {
		uint strike_per_nominal_unit;
		uint expiry;
	}

	SmartOptionEthVsERC20[] _options;
	// expiry => strike => IBook
	mapping(uint => mapping(uint => IBook)) public _books;
	mapping(address => BookData) public _book_data;

	constructor(address pricing_token_vault, address book_factory) public {
		_pricing_token_vault = IERC20(pricing_token_vault);
		_book_factory = IBookFactory(book_factory);
	}

	modifier reset_order_state() {
		_;
		_current_order_book = address(0);
		_current_option_contract = address(0);
	}

	function buy(address book_address, uint quantity, uint32 price) reset_order_state external returns(IBook.Status order_status) {
		BookData memory data = _book_data[book_address];
		require(data.expiry > now);

		IBook book = IBook(book_address);
		_current_order_book = book_address;
		IBook.Result memory result = book.buy(msg.sender, quantity, price);

		if ( result.status == IBook.Status.PARTIAL_EXEC )
		{
			_pricing_token_vault.transferFrom(msg.sender, address(this), result.order.quantity * result.order.price);
		} else if ( result.status == IBook.Status.BOOKED ) {
			_pricing_token_vault.transferFrom(msg.sender, address(this), quantity * price);
		}

		return result.status;
	}

	function sell_contract(address book_address, SmartOptionEthVsERC20 option_contract, uint quantity, uint32 price) reset_order_state internal returns(IBook.Status order_status) {
		IBook book = IBook(book_address);
		_current_order_book = book_address;
		_current_option_contract = address(option_contract);
		option_contract.lock(msg.sender, quantity);
		return book.sell(msg.sender, msg.value, price).status;
	}

	function cancel(address book_address, bytes32 order_id) external {
		BookData memory data = _book_data[book_address];
		require(data.expiry > 0);
		IBook book = IBook(book_address);
		IBook.Order memory o = book.cancel(msg.sender, order_id);

		if (o.user_data != bytes20(0))
		{
			SmartOptionEthVsERC20(address(o.user_data)).unlock(o.issuer, o.quantity);
		}
		else
		{
			_pricing_token_vault.transfer(o.issuer, o.quantity*o.price);
		}
	}

	function on_buy_execution(bytes20 hit_order_user_data) external {
		require(msg.sender == _current_order_book
			&&	hit_order_user_data != bytes20(0)
			&&	_current_option_contract == address(0)
			);
		IBook book = IBook(_current_order_book);
		IBook.Execution memory execution = book.last_execution();
		address option_address = address(hit_order_user_data);
		SmartOptionEthVsERC20(option_address).transferLocked(execution.seller, execution.buyer, execution.quantity);
		_pricing_token_vault.transferFrom(execution.buyer, execution.seller, execution.price * execution.quantity);
	}

	function on_sell_execution(bytes20 hit_order_user_data) external {
		require(msg.sender == _current_order_book
			&&	hit_order_user_data == bytes20(0)
			&&	_current_option_contract != address(0)
			);
		IBook book = IBook(_current_order_book);
		IBook.Execution memory execution = book.last_execution();
		address option_address = _current_option_contract;
		SmartOptionEthVsERC20(option_address).transferLocked(execution.seller, execution.buyer, execution.quantity);
		_pricing_token_vault.transferFrom(address(this), execution.seller, execution.price * execution.quantity);
	}

	function on_expired(IBook.Order calldata order) external {
		require(msg.sender == _current_order_book);

		if(order.user_data != bytes20(0))
		{
			SmartOptionEthVsERC20(address(order.user_data)).unlock(order.issuer, order.quantity);
		}
		else
		{
			_pricing_token_vault.transfer(order.issuer, order.quantity*order.price);
		}
	}

	function get_user_data() external returns(bytes20 order_user_data) {
		require(msg.sender == _current_order_book);
		return bytes20(_current_option_contract);
	}

	function emit_book_opened(address book_address, uint expiry, uint strike) internal;

	function open_book(
			uint expiry_offset
		,	uint strike_per_nominal_unit
		,	uint minimum_order_quantity
		,	uint price_tick_size
		,	uint max_order_lifetime
	) external payable {
		uint expiry = require_valid_expiry_offset(expiry_offset);
		
		require(address(0) == address(_books[expiry][strike_per_nominal_unit])
			&&	strike_per_nominal_unit > 0
			&&	max_order_lifetime >= MINIMUM_ORDER_LIFETIME
			&&	msg.value == BOOK_OPENING_FEE);

		IBook book = _book_factory.create(minimum_order_quantity, price_tick_size, max_order_lifetime);
		_books[expiry][strike_per_nominal_unit] = book;
		BookData storage data = _book_data[address(book)];
		data.strike_per_nominal_unit = strike_per_nominal_unit;
		data.expiry = expiry;
		emit_book_opened(address(book), expiry, strike_per_nominal_unit);
	}

	function roll_book(address book_address, uint expiry_offset) external {
		uint expiry = require_valid_expiry_offset(expiry_offset);
		BookData storage data = _book_data[book_address];
		IBook book = _books[data.expiry][data.strike_per_nominal_unit];
		
		require(data.expiry < now
			&&	book_address == address(book)
			&&	address(0) == address(_books[expiry][data.strike_per_nominal_unit]));
		
		delete _books[data.expiry][data.strike_per_nominal_unit];
		_books[expiry][data.strike_per_nominal_unit] = book;
		book.clear();
		
		emit_book_opened(book_address, expiry, data.strike_per_nominal_unit);
	}

	function close_book(address book_address) external {
		BookData memory data = _book_data[book_address];
		
		require(data.expiry + BOOK_CLOSE_DELAY < now && data.expiry != 0);

        IBook book = _books[data.expiry][data.strike_per_nominal_unit];
		delete _books[data.expiry][data.strike_per_nominal_unit];
		delete _book_data[book_address];
		book.clear();

		msg.sender.transfer(BOOK_OPENING_FEE);
		emit BookClosed(book_address);
	}
}


contract CallMarketPlace is OptionMarketPlace {
	constructor(address pricing_token_vault, address book_factory) public
		OptionMarketPlace(pricing_token_vault, book_factory) {}

	function sell(address book_address, uint32 price) external payable returns(IBook.Status order_status) {
		BookData memory data = _book_data[book_address];
		require(data.expiry > now);
		SmartOptionEthVsERC20 option = (new CoveredEthCall).value(msg.value)(
				_pricing_token_vault
			,	data.strike_per_nominal_unit
			,	data.expiry
			,	msg.sender
			,	msg.sender
			);
		_options.push(option);
		return sell_contract(
				book_address
			,	option
			,	msg.value
			,	price);
	}

	function sell_secondary(address book_address, uint quantity, uint32 price, address option_address) external returns(IBook.Status order_status) {
		CoveredEthCall option_contract = CoveredEthCall(option_address);
		BookData memory data = _book_data[book_address];
		require(data.expiry > now
			&&	data.expiry == option_contract._expiry()
			&&	data.strike_per_nominal_unit == option_contract._strike_per_nominal_unit()
			&&	address(this) == option_contract._issuer()
			&&	option_contract.balanceOf(msg.sender) >= quantity
			);
		return sell_contract(
				book_address
			,	option_contract
			,	quantity
			,	price);
	}

	function emit_book_opened(address book_address, uint expiry, uint strike) internal {
		emit BookOpened(book_address, OptionType.CALL, expiry, strike);
	}
}


contract PutMarketPlace is OptionMarketPlace {
	constructor(address pricing_token_vault, address book_factory) public
		OptionMarketPlace(pricing_token_vault, book_factory) {}

	function sell(address book_address, uint quantity, uint32 price) external payable returns(IBook.Status order_status) {
		BookData memory data = _book_data[book_address];
		require(data.expiry > now);
		SmartOptionEthVsERC20 option = new CoveredEthPut(
				_pricing_token_vault
			,	quantity
			,	data.strike_per_nominal_unit
			,	data.expiry
			,	msg.sender
			,	msg.sender
			);
		_options.push(option);
		return sell_contract(
				book_address
			,	option
			,	quantity
			,	price);
	}

	function sell_secondary(address book_address, uint quantity, uint32 price, address option_address) external returns(IBook.Status order_status) {
		CoveredEthPut option_contract = CoveredEthPut(option_address);
		BookData memory data = _book_data[book_address];
		require(data.expiry > now
			&&	data.expiry == option_contract._expiry()
			&&	data.strike_per_nominal_unit == option_contract._strike_per_nominal_unit()
			&&	address(this) == option_contract._issuer()
			&&	option_contract.balanceOf(msg.sender) >= quantity
			);
		return sell_contract(
				book_address
			,	option_contract
			,	quantity
			,	price);
	}

	function emit_book_opened(address book_address, uint expiry, uint strike) internal {
		emit BookOpened(book_address, OptionType.PUT, expiry, strike);
	}
}
