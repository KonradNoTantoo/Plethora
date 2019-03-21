pragma solidity ^0.5.5;
pragma experimental ABIEncoderV2;


import "./CoveredOption.sol";
import "./OrderBook.sol";


contract OptionMarketPlace is IMarketPlace {
	enum OptionType { CALL, PUT }
	event BookOpened(address book_address, OptionType type, uint expiry, uint strike);
	event BookClosed(address book_address);

	uint constant EXPIRY_ORIGIN_TIME = 1546351200; // January 1st 2019, 14:00
	uint constant MINIMUM_TRADING_TIME = 1 days;
	uint constant MINIMUM_ORDER_LIFETIME = 1 days;
	uint constant BOOK_OPENING_FEE = 1 finney;
	uint constant BOOK_CLOSE_DELAY = 100 days;

	function to_expiry_offset(uint expiry_timestamp) external view returns(uint offset) {
		require(expiry_timestamp > EXPIRY_ORIGIN_TIME);
		return expiry_timestamp - EXPIRY_ORIGIN_TIME;
	}

	function require_valid_expiry_offset(uint offset) public view returns(uint expiry_timestamp) {
		uint expiry = offset + EXPIRY_ORIGIN_TIME;
		require(expiry >= (now + MINIMUM_TRADING_TIME) && (offset % 1 days) == 0);
		return expiry;
	}

	IERC20 public _pricing_token_vault;
	address private _current_order_book;
	address private _current_option_contract;

	struct BookData {
		uint strike_per_nominal_unit;
		uint expiry;
	}

	SmartOptionEthVsERC20[] _options;
	// expiry => strike => Book
	mapping(uint => mapping(uint => Book)) public _books;
	mapping(address => BookData) public _book_data;

	constructor(address pricing_token_vault) public {
		_pricing_token_vault = IERC20(pricing_token_vault);
	}

	modifier reset_order_state() {
		_;
		_current_order_book = address(0);
		_current_option_contract = address(0);
	}

	function buy(address book_address, uint quantity, uint32 price) external returns(Book.Status order_status) reset_order_state {
		BookData memory data = _book_data[book_address];
		require(data.expiry > now);
		Book book = Book(book_address);
		_current_order_book = book_address;
		return book.buy(msg.sender, quantity, price);
	}

	function sell_contract(address book_address, SmartOptionEthVsERC20 option_contract, uint quantity, uint32 price) internal returns(Book.Status order_status) reset_order_state {
		Book book = Book(book_address);
		_current_order_book = book_address;
		_current_option_contract = address(option_contract);
		option_contract.lock(quantity);
		return book.sell(msg.sender, msg.value, price);
	}

	function cancel(address book_address, bytes32 order_id) external {
		BookData memory data = _book_data[book_address];
		require(data.expiry > 0);
		Book book = Book(book_address);
		Book.Order memory order = book.cancel(order_id);

		if (order.user_data != bytes20(0))
		{
			SmartOptionEthVsERC20(address(order.user_data)).unlock(order.quantity);
		}
	}

	function on_execution(bytes20 hit_order_user_data) external {
		require(msg.sender == _current_order_book);
		Book book = Book(msg.sender);

		Book.Execution memory execution = book._executions[book._executions.length - 1];

		address option_address = address(hit_order_user_data);

		if (option_address == address(0)) {
			option_address = _current_option_contract;
		}

		assert(option_address != address(0));

		SmartOptionEthVsERC20(option_address).transferLocked(execution.seller, execution.buyer, execution.quantity);

		uint order_nominal = execution.price * execution.quantity;
		require(order_nominal > execution.price && order_nominal > execution.quantity);
		_pricing_token_vault.transferFrom(execution.buyer, execution.seller, order_nominal);
	}

	function on_expired(uint epxired_quantity, bytes20 user_data) external {
		require(msg.sender == _current_order_book);
		assert(user_data != bytes20(0));
		SmartOptionEthVsERC20(address(user_data)).unlock(epxired_quantity);
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

		Book book = new Book(minimum_order_quantity, price_tick_size, max_order_lifetime);
		_books[expiry][strike_per_nominal_unit] = book;
		BookData storage data = _book_data[address(book)];
		data.strike_per_nominal_unit = strike_per_nominal_unit;
		data.expiry = expiry;
		emit_book_opened(address(book), expiry, strike_per_nominal_unit);
	}

	function roll_book(address book_address, uint expiry_offset) external {
		uint expiry = require_valid_expiry_offset(expiry_offset);
		BookData storage data = _book_data[book_address];
		Book book = _books[data.expiry][data.strike_per_nominal_unit];
		
		require(data.expiry < now
			&&	book_address == address(book)
			&&	address(0) == _books[expiry][data.strike_per_nominal_unit]);
		
		delete _books[data.expiry][data.strike_per_nominal_unit];
		_books[expiry][data.strike_per_nominal_unit] = book;
		book.clear();
		
		emit_book_opened(book_address, expiry, data.strike_per_nominal_unit);
	}

	function close_book(address book_address) external {
		BookData memory data = _book_data[book_address];
		
		require(data.expiry + BOOK_CLOSE_DELAY < now && data.expiry != 0);
		
		delete _books[data.expiry][data.strike_per_nominal_unit];
		delete _book_data[book_address];
		book.clear();

		msg.sender.transfer(BOOK_OPENING_FEE);
		emit BookClosed(book_address);
	}
}


contract CallMarketPlace is OptionMarketPlace {
	constructor(address pricing_token_vault) public OptionMarketPlace(pricing_token_vault) {}

	function sell(address book_address, uint32 price) external payable returns(Book.Status order_status) {
		BookData memory data = _book_data[book_address];
		require(data.expiry > now);
		SmartOptionEthVsERC20 option = (new CoveredEthCall)).value(msg.value)(
				_pricing_token_vault
			,	data.strike_per_nominal_unit
			,	data.expiry
			,	msg.sender
			,	msg.sender
			)
		_options.push(option);
		return sell_contract(
				book_address
			,	option
			,	msg.value
			,	price);
	}

	function sell_secondary(address book_address, uint quantity, uint32 price, address option_address) external returns(Book.Status order_status) {
		CoveredEthCall option_contract = CoveredEthCall(option_address);
		BookData memory data = _book_data[book_address];
		require(data.expiry > now
			&&	data.expiry == option_contract._expiry
			&&	data.strike_per_nominal_unit == option_contract._strike_per_nominal_unit
			&&	address(this) == option_contract._issuer
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
	constructor(address pricing_token_vault) public OptionMarketPlace(pricing_token_vault) {}

	function sell(address book_address, uint quantity, uint32 price) external payable returns(Book.Status order_status) {
		BookData memory data = _book_data[book_address];
		require(data.expiry > now);
		SmartOptionEthVsERC20 option = new CoveredEthPut(
				_pricing_token_vault
			,	quantity
			,	data.strike_per_nominal_unit
			,	data.expiry
			,	msg.sender
			,	msg.sender
			)
		_options.push(option);
		return sell_contract(
				book_address
			,	option
			,	quantity
			,	price);
	}

	function sell_secondary(address book_address, uint quantity, uint32 price, address option_address) external returns(Book.Status order_status) {
		CoveredEthPut option_contract = CoveredEthPut(option_address);
		BookData memory data = _book_data[book_address];
		require(data.expiry > now
			&&	data.expiry == option_contract._expiry
			&&	data.strike_per_nominal_unit == option_contract._strike_per_nominal_unit
			&&	address(this) == option_contract._issuer
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
