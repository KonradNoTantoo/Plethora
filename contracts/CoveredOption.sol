pragma solidity ^0.5.5;

import 'IERC20.sol';
import 'Common.sol';


contract SmartOptionEthVsERC20 is IERC20 {
	enum Status { WAITING, RUNNING, EXPIRED, SETTLED, LIQUIDATED }

	uint constant SETTLEMENT_DELAY = 1 days;
	uint constant LIQUIDATION_DELAY = 10 days;

	Status internal _status;

	address public _issuer;

	IERC20 _erc20_minter;

	uint public _underlying_quantity;
	uint public _strike_per_underlying_unit;
	uint public _expiry;

	mapping(address => mapping (address => uint256)) private _allowed;
	mapping(address => uint) public _nominal_shares;
	mapping(address => uint) public _locked_shares;
	address payable public _writer;

	constructor(
			IERC20 erc20_minter
		,	uint underlying_quantity
		,	uint strike_per_underlying_unit
		,	uint expiry
		,	address buyer
		,	address payable writer
	) public {
		require(
				address(0) != address(erc20_minter)
			&&	address(0) != buyer
			&&	address(0) != writer
			&&	underlying_quantity > 0
			&&	expiry > now
			&&	PriceLib.is_valid_nominal(underlying_quantity, strike_per_underlying_unit)
			);

		_erc20_minter = erc20_minter;

		_underlying_quantity = underlying_quantity;
		_strike_per_underlying_unit = strike_per_underlying_unit;		
		_expiry = expiry;
		_issuer = msg.sender;

		_nominal_shares[buyer] = _underlying_quantity;
		_writer = writer;

		_status = Status.WAITING;
	}

	function strike() public view returns(uint) {
		return PriceLib.nominal_value(_underlying_quantity, _strike_per_underlying_unit);
	}

	function isExpired() public view returns(bool expired) {
		return now >= _expiry;
	}

	function getStatus() external view returns(Status current_status) {
		return _status == Status.RUNNING && isExpired()
			? Status.EXPIRED
			: _status;
	}

	function lock(address buyer, uint nb_shares) external {
		require(_issuer == msg.sender && _nominal_shares[buyer] >= nb_shares);
		_locked_shares[buyer] = nb_shares;
	}

	function unlock(address buyer, uint nb_shares) external {
		require(_issuer == msg.sender && _locked_shares[buyer] >= nb_shares);
		_locked_shares[buyer] -= nb_shares;
	}

	function settle() external {
		require(
				now >= _expiry + SETTLEMENT_DELAY
			&&	_status == Status.RUNNING
			);

		_status = Status.SETTLED;
		_writer.transfer(address(this).balance);
		require(_erc20_minter.transfer(_writer, _erc20_minter.balanceOf(address(this))));
	}

	function liquidate() external {
		require(
				now >= _expiry + LIQUIDATION_DELAY
			&&	_status != Status.LIQUIDATED
			);

		_status = Status.LIQUIDATED;
		msg.sender.transfer(address(this).balance);
		require(_erc20_minter.transfer(msg.sender, _erc20_minter.balanceOf(address(this))));
	}

	// ERC20 implementation

	uint8 public constant decimals = 18;

	/**
	* @dev Total number of tokens in existence
	*/
	function totalSupply() public view returns (uint256) {
		return _underlying_quantity;
	}

	/**
	* @dev Gets the balance of the specified address.
	* @param owner The address to query the balance of.
	* @return An uint256 representing the amount owned by the passed address.
	*/
	function balanceOf(address owner) public view returns (uint256) {
		return _nominal_shares[owner];
	}

	/**
	* @dev Function to check the amount of tokens that an owner allowed to a spender.
	* @param owner address The address which owns the funds.
	* @param spender address The address which will spend the funds.
	* @return A uint256 specifying the amount of tokens still available for the spender.
	*/
	function allowance(address owner, address spender) public view returns (uint256) {
		return _allowed[owner][spender];
	}

	/**
	* @dev Transfer token for a specified address
	* @param to The address to transfer to.
	* @param nb_shares The amount to be transferred.
	*/
	function transfer(address to, uint256 nb_shares) public returns (bool) {
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
	function approve(address spender, uint256 nb_shares) public returns (bool) {
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
	function transferFrom(address from, address to, uint256 nb_shares) public returns (bool) {
		require(
				nb_shares <= _nominal_shares[from] - _locked_shares[from]
			&&	(msg.sender == _issuer || nb_shares <= _allowed[from][msg.sender])
			&&	to != address(0)
			);

		_nominal_shares[from] -= nb_shares;
		_nominal_shares[to] += nb_shares;

		if (msg.sender != _issuer)
		{
			_allowed[from][msg.sender] -= nb_shares;
		}

		emit Transfer(from, to, nb_shares);
		return true;
	}

	function transferLocked(address from, address to, uint256 nb_shares) public returns (bool) {
		require(
				nb_shares <= _locked_shares[from]
			&&	msg.sender == _issuer
			&&	to != address(0)
			);

		_nominal_shares[from] -= nb_shares;
		_locked_shares[from] -= nb_shares;
		_nominal_shares[to] += nb_shares;

		emit Transfer(from, to, nb_shares);
		return true;
	}
}



contract CoveredEthCall is SmartOptionEthVsERC20 {
	constructor(IERC20 erc20_minter, uint strike_per_underlying_unit, uint expiry, address buyer, address payable writer) public payable
		SmartOptionEthVsERC20(erc20_minter, msg.value, strike_per_underlying_unit, expiry, buyer, writer)
	{
		_status = Status.RUNNING;
	}

	function call(address payable buyer, uint quantity) public {
		uint shares = _nominal_shares[buyer];
		_nominal_shares[buyer] = shares - quantity;
		require(
				msg.sender == _issuer
			&&	isExpired()
			&&	quantity > 0
			&&	quantity <= shares
			&&	_erc20_minter.transferFrom(buyer, address(this), PriceLib.nominal_value(quantity, _strike_per_underlying_unit))
			);
		buyer.transfer(quantity);
	}

	// ERC20 implementation

	string public constant name = "Eth call option";
	string public constant symbol = "OPTC";
}



contract CoveredEthPut is SmartOptionEthVsERC20 {
	constructor(IERC20 erc20_minter, uint underlying_quantity, uint strike_per_underlying_unit, uint expiry, address buyer, address payable writer) public
		SmartOptionEthVsERC20(erc20_minter, underlying_quantity, strike_per_underlying_unit, expiry, buyer, writer) {}

	function activate() external {
		require(_status == Status.WAITING
			&&	_erc20_minter.balanceOf(address(this)) == strike()
			);
		_status = Status.RUNNING;
	}

	function put(address buyer) public payable {
		uint shares = _nominal_shares[buyer];
		_nominal_shares[buyer] = shares - msg.value;
		require(
				msg.sender == _issuer
			&&	isExpired()
			&&	msg.value > 0
			&&	msg.value <= shares
		 	&&	_erc20_minter.transfer(buyer, PriceLib.nominal_value(msg.value, _strike_per_underlying_unit))
		 	);
	}

	// ERC20 implementation

	string public constant name = "Eth put option";
	string public constant symbol = "OPTP";
}
