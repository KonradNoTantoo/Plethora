pragma solidity ^0.5.5;

import 'IERC20.sol';


/**
* @dev Just for testing purposes
*/
contract Plethora is IERC20 {
	uint public _mass;

	mapping(address => mapping (address => uint256)) private _allowed;
	mapping(address => uint) public _token_registry;

	function mintFor(address owner, uint nb_token) public {
		uint new_mass = nb_token + _mass;
		require(new_mass >= nb_token && new_mass >= _mass);
		_token_registry[owner] += nb_token;
		_mass = new_mass;
	}

	function mint(uint nb_token) external {
		mintFor(msg.sender, nb_token);
	}

	/**
	* @dev Total number of tokens in existence
	*/
	function totalSupply() public view returns (uint256) {
		return _mass;
	}

	/**
	* @dev Gets the balance of the specified address.
	* @param owner The address to query the balance of.
	* @return An uint256 representing the amount owned by the passed address.
	*/
	function balanceOf(address owner) public view returns (uint256) {
		return _token_registry[owner];
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
	* @param nb_token The amount to be transferred.
	*/
	function transfer(address to, uint256 nb_token) public returns (bool) {
		require(
				nb_token <= _token_registry[msg.sender]
			&&	to != address(0)
			);

		_token_registry[msg.sender] -= nb_token;
		_token_registry[to] += nb_token;
		emit Transfer(msg.sender, to, nb_token);
		return true;
	}

	/**
	* @dev Approve the passed address to spend the specified amount of tokens on behalf of msg.sender.
	* Beware that changing an allowance with this method brings the risk that someone may use both the old
	* and the new allowance by unfortunate transaction ordering. One possible solution to mitigate this
	* race condition is to first reduce the spender's allowance to 0 and set the desired value afterwards:
	* https://github.com/ethereum/EIPs/issues/20#issuecomment-263524729
	* @param spender The address which will spend the funds.
	* @param nb_token The amount of tokens to be spent.
	*/
	function approve(address spender, uint256 nb_token) public returns (bool) {
		require(spender != address(0));

		_allowed[msg.sender][spender] = nb_token;
		emit Approval(msg.sender, spender, nb_token);
		return true;
	}

	/**
	* @dev Transfer tokens from one address to another
	* @param from address The address which you want to send tokens from
	* @param to address The address which you want to transfer to
	* @param nb_token uint256 the amount of tokens to be transferred
	*/
	function transferFrom(address from, address to, uint256 nb_token) public returns (bool) {
		require(
				nb_token <= _token_registry[from]
			&&	nb_token <= _allowed[from][msg.sender]
			&&	to != address(0)
			);

		_token_registry[from] -= nb_token;
		_token_registry[to] += nb_token;

		emit Transfer(from, to, nb_token);
		return true;
	}
}
