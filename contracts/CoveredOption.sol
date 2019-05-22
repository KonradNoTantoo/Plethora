pragma solidity ^0.5.5;

import 'IERC20.sol';
import 'Common.sol';


contract SmartOptionEthVsERC20 is IERC20 {
	enum Status { RUNNING, EXPIRED, SETTLING, LIQUIDATED }

	uint constant SETTLEMENT_DELAY = 1 days;
	uint constant LIQUIDATION_DELAY = 10 days;

	Status internal _status;

	IERC20 _erc20_minter;

	uint public _underlying_quantity;
	uint public _exercised_quantity;
	uint public _strike_per_underlying_unit;
	uint public _expiry;

	mapping(address => mapping (address => uint256)) private _allowed;
	mapping(address => uint) public _nominal_shares;
	mapping(address => uint) public _locked_shares;
	mapping(address => uint) public _writers;

	constructor(
			IERC20 erc20_minter
		,	uint strike_per_underlying_unit
		,	uint expiry
	) public {
		require(
				address(0) != address(erc20_minter)
			&&	strike_per_underlying_unit > 0
			&&	expiry > now
			);

		_erc20_minter = erc20_minter;

		_underlying_quantity = 0;
		_exercised_quantity = 0;
		_strike_per_underlying_unit = strike_per_underlying_unit;
		_expiry = expiry;

		_status = Status.RUNNING;
	}

	function _is_expired() internal view returns(bool expired) {
		return now >= _expiry;
	}

	function _lock(address buyer, uint nb_shares) internal {
		require( _nominal_shares[buyer] - _locked_shares[buyer] >= nb_shares );
		_locked_shares[buyer] += nb_shares;
	}

	function _unlock(address buyer, uint nb_shares) internal {
		require( _locked_shares[buyer] >= nb_shares );
		_locked_shares[buyer] -= nb_shares;
	}

	function _transfer_from(address from, address to, uint256 nb_shares) internal {
		require(
				nb_shares <= _nominal_shares[from] - _locked_shares[from]
			&&	to != address(0)
			);

		_nominal_shares[from] -= nb_shares;
		_nominal_shares[to] += nb_shares;

		emit Transfer(from, to, nb_shares);
	}

	function _transfer_locked(address from, address to, uint256 nb_shares) internal {
		require(
				nb_shares <= _locked_shares[from]
			&&	to != address(0)
			);

		_nominal_shares[from] -= nb_shares;
		_locked_shares[from] -= nb_shares;
		_nominal_shares[to] += nb_shares;

		emit Transfer(from, to, nb_shares);
	}

	function _emit_shares(address writer, address buyer, uint quantity) internal {
		uint new_quantity = quantity + _underlying_quantity;
		require(new_quantity >= quantity && new_quantity >= _underlying_quantity
			&&	PriceLib.is_valid_nominal(new_quantity, _strike_per_underlying_unit)
			);
		_underlying_quantity = new_quantity;
		_writers[writer] += quantity;
		_nominal_shares[buyer] += quantity;
	}

	function _cross_shares(address writer) internal returns(uint crossed) {
		uint written = _writers[writer];

		if (written > 0)
		{
			uint crossable = _nominal_shares[writer] - _locked_shares[writer];

			if (crossable < written)
			{
				_writers[writer] -= crossable;
				_nominal_shares[writer] -= crossable;
				_underlying_quantity -= crossable;
				return crossable;
			}

			delete _writers[writer];
			_nominal_shares[writer] -= written;
			_underlying_quantity -= written;
			return written;
		}

		return 0;
	}

	function _settle() internal returns(uint shares) {
		bool is_running = (_status == Status.RUNNING);

		require(
				now >= _expiry + SETTLEMENT_DELAY
			&&	(	is_running
				||	_status == Status.SETTLING
				)
			);

		if ( is_running ) {
			_status = Status.SETTLING;
		}

		uint balance = _writers[msg.sender];
		_writers[msg.sender] = 0;
		return balance;
	}

	function free_shares(address guy) external view returns(uint nb_shares) {
		return _nominal_shares[guy] - _locked_shares[guy];
	}

	function status() external view returns(Status current_status) {
		return _status == Status.RUNNING && _is_expired()
			? Status.EXPIRED
			: _status;
	}

	function _liquidate(address payable liquidator) internal {
		require(
				now >= _expiry + LIQUIDATION_DELAY
			&&	_status != Status.LIQUIDATED
			);

		_status = Status.LIQUIDATED;
		require(_erc20_minter.transfer(liquidator, _erc20_minter.balanceOf(address(this))));
		selfdestruct(liquidator);
	}

	function can_liquidate() external view returns(bool) {
		return now >= _expiry + LIQUIDATION_DELAY && _status != Status.LIQUIDATED;
	}

	function can_exercise() external view returns(bool) {
		return _is_expired() && now < _expiry + SETTLEMENT_DELAY;
	}

	function can_settle() external view returns(bool) {
		return now >= _expiry + SETTLEMENT_DELAY && _status != Status.LIQUIDATED;
	}

	// ERC20 implementation

	uint8 public constant decimals = 18;

	/**
	* @dev Total number of tokens in existence
	*/
	function totalSupply() external view returns (uint256) {
		return _underlying_quantity;
	}

	/**
	* @dev Gets the balance of the specified address.
	* @param owner The address to query the balance of.
	* @return An uint256 representing the amount owned by the passed address.
	*/
	function balanceOf(address owner) external view returns (uint256) {
		return _nominal_shares[owner];
	}

	/**
	* @dev Function to check the amount of tokens that an owner allowed to a spender.
	* @param owner address The address which owns the funds.
	* @param spender address The address which will spend the funds.
	* @return A uint256 specifying the amount of tokens still available for the spender.
	*/
	function allowance(address owner, address spender) external view returns (uint256) {
		return _allowed[owner][spender];
	}

	/**
	* @dev Transfer token for a specified address
	* @param to The address to transfer to.
	* @param nb_shares The amount to be transferred.
	*/
	function transfer(address to, uint256 nb_shares) external returns (bool) {
		require(
				nb_shares <= _nominal_shares[msg.sender] - _locked_shares[msg.sender]
			&&	to != address(0)
			);

		_nominal_shares[msg.sender] -= nb_shares;
		_nominal_shares[to] += nb_shares;
		emit Transfer(msg.sender, to, nb_shares);
		return true;
	}

	/**
	* @dev Approve the passed address to spend the specified amount of tokens on behalf of msg.sender.
	* Beware that changing an allowance with this method brings the risk that someone may use both the old
	* and the new allowance by unfortunate transaction ordering. One possible solution to mitigate this
	* race condition is to first reduce the spender's allowance to 0 and set the desired value afterwards:
	* https://github.com/ethereum/EIPs/issues/20#issuecomment-263524729
	* @param spender The address which will spend the funds.
	* @param nb_shares The amount of tokens to be spent.
	*/
	function approve(address spender, uint256 nb_shares) external returns (bool) {
		require(spender != address(0));
		_allowed[msg.sender][spender] = nb_shares;
		emit Approval(msg.sender, spender, nb_shares);
		return true;
	}

	/**
	* @dev Transfer tokens from one address to another
	* @param from address The address which you want to send tokens from
	* @param to address The address which you want to transfer to
	* @param nb_shares uint256 the amount of tokens to be transferred
	*/
	function transferFrom(address from, address to, uint256 nb_shares) external returns (bool) {
		require( nb_shares <= _allowed[from][msg.sender] );
		_transfer_from(from, to, nb_shares);
		_allowed[from][msg.sender] -= nb_shares;
		return true;
	}
}



contract CoveredEthCall is SmartOptionEthVsERC20 {
	constructor(IERC20 erc20_minter, uint strike_per_underlying_unit, uint expiry) public
		SmartOptionEthVsERC20(erc20_minter, strike_per_underlying_unit, expiry) {}

	function call(uint quantity) external {
		uint shares = _nominal_shares[msg.sender];
		_nominal_shares[msg.sender] = shares - quantity;
		require(
 				_is_expired()
			&&	_status == Status.RUNNING
			&&	quantity > 0
			&&	quantity <= shares
			&&	_erc20_minter.transferFrom(msg.sender, address(this), PriceLib.nominal_value(quantity, _strike_per_underlying_unit))
			);
		msg.sender.transfer(quantity);
		_exercised_quantity += quantity;
	}

	function emit_shares(address writer, address buyer) external payable {
		require(false == _is_expired()
			&&	address(0) != buyer
			&&	address(0) != writer);
		_emit_shares(writer, buyer, msg.value);
	}

	function settle() external {
		uint balance = _settle();

		if ( _exercised_quantity > 0 ) {
			require(_erc20_minter.transfer(msg.sender,
				PriceLib.nominal_value((balance*_exercised_quantity)/_underlying_quantity, _strike_per_underlying_unit)));
		}

		uint unexercised_quantity = _underlying_quantity - _exercised_quantity;

		if ( unexercised_quantity > 0 ) {
			msg.sender.transfer((balance*unexercised_quantity)/_underlying_quantity);
		}
	}

	function _cross_call_shares(address payable guy) internal {
		guy.transfer(_cross_shares(guy));
	}

	function cross_call_shares() external {
		require(false == _is_expired());
		_cross_call_shares(msg.sender);
	}

	// ERC20 implementation

	string public constant name = "Eth call option";
	string public constant symbol = "OPTC";
}



contract CoveredEthPut is SmartOptionEthVsERC20 {
	constructor(IERC20 erc20_minter, uint strike_per_underlying_unit, uint expiry) public
		SmartOptionEthVsERC20(erc20_minter, strike_per_underlying_unit, expiry) {}

	function put() external payable {
		uint shares = _nominal_shares[msg.sender];
		_nominal_shares[msg.sender] = shares - msg.value;
		require(
				_is_expired()
			&&	_status == Status.RUNNING
			&&	msg.value > 0
			&&	msg.value <= shares
		 	&&	_erc20_minter.transfer(msg.sender, PriceLib.nominal_value(msg.value, _strike_per_underlying_unit))
		 	);
		_exercised_quantity += msg.value;
	}

	function emit_shares(address writer, address buyer, uint quantity) external {
		require(false == _is_expired()
			&&	address(0) != buyer
			&&	address(0) != writer
			&&	_erc20_minter.transferFrom(
					msg.sender,
					address(this),
					PriceLib.nominal_value(quantity, _strike_per_underlying_unit)
				)
			);
		_emit_shares(writer, buyer, quantity);
	}

	function settle() external {
		uint balance = _settle();

		if ( _exercised_quantity > 0 ) {
			msg.sender.transfer((balance*_exercised_quantity)/_underlying_quantity);
		}

		uint unexercised_quantity = _underlying_quantity - _exercised_quantity;

		if ( unexercised_quantity > 0 ) {
			require(_erc20_minter.transfer(msg.sender,
				PriceLib.nominal_value((balance*unexercised_quantity)/_underlying_quantity, _strike_per_underlying_unit)));
		}
	}

	function _cross_put_shares(address guy) internal {
		uint crossed = _cross_shares(guy);

		if (crossed > 0) {
			_erc20_minter.transfer(
					guy,
					PriceLib.nominal_value(crossed, _strike_per_underlying_unit)
				);
		}
	}

	function cross_put_shares() external {
		require(false == _is_expired());
		_cross_put_shares(msg.sender);
	}

	// ERC20 implementation

	string public constant name = "Eth put option";
	string public constant symbol = "OPTP";
}
