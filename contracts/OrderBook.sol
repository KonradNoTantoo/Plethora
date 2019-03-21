pragma solidity ^0.5.5;
pragma experimental ABIEncoderV2;


import "Interfaces.sol";


contract Book is IBook {
	event BuyOrder(bytes32 id);
	event SellOrder(bytes32 id);
	event Expired(bytes32 id);
	event Cancelled(bytes32 id);
	event Hit(bytes32 hit_order, address buyer, address seller, uint price, uint quantity);

	struct Entry {
		int signed_price;
		bytes32[] order_ids;
	}

	Entry[] public _bid;
	Entry[] public _ask;
	Execution[] public _executions;
	mapping (bytes32 => Order) public _orders;
	uint public _minimum_order_quantity;
	uint public _price_tick_size;
	uint public _max_order_lifetime;

	IMarketPlace public _parent;

	constructor(
			uint minimum_order_quantity
		,	uint price_tick_size
		,	uint max_order_lifetime
		) public {
		require(minimum_order_quantity > 0 && price_tick_size > 0 && max_order_lifetime > 0);
		_minimum_order_quantity = minimum_order_quantity;
		_price_tick_size = price_tick_size;
		_max_order_lifetime = max_order_lifetime;
		_parent = IMarketPlace(msg.sender);
	}

	function full_exec_result() internal pure returns(Result memory full_exec) {
		Result memory result;
		result.status = Status.FULL_EXEC;
		return result;
	}

	function in_book_result(Order memory order, bool partial_exec) internal pure returns(Result memory in_book) {
		Result memory result;
		result.status = partial_exec ? Status.PARTIAL_EXEC : Status.BOOKED;
		result.order = order;
		return result;
	}

	function last_execution() external view returns(Execution memory last) {
		return _executions[_executions.length-1];
	}

	function get_order(bytes32 order_id) external view returns(Order memory gotten) {
		return _orders[order_id];
	}

	function is_order_legal(uint quantity, uint32 price) public view returns(bool legal) {
		uint order_nominal = quantity * price;
		return quantity >= _minimum_order_quantity
			&& price % _price_tick_size == 0
			&& order_nominal >= quantity
			&& order_nominal >= price;
	}

	function compute_order_id(Order memory order) public pure returns (bytes32 id) {
		return keccak256(abi.encodePacked(order.time, order.user_data, order.issuer));
	}

	function new_entry(Entry[] storage entries, uint index, int price, bytes32 order_id) internal {
		++entries.length;

		for(uint i = entries.length - 1; i > index; --i) {
			entries[i] = entries[i-1];
		}

		Entry storage e = entries[index];
		e.signed_price = price;
		delete e.order_ids;
		e.order_ids.push(order_id);
	}

	function on_execution(bytes32 hit_order, Execution memory exec) internal {
		_executions.push(exec);
		emit Hit(hit_order, exec.buyer, exec.seller, exec.price, exec.quantity);
	}

	function enter_order(Entry[] storage entries, int price, bytes32 order_id) internal {
		for (uint i = entries.length; i > 0; --i) {
			Entry storage entry = entries[i-1];

			if (entry.signed_price == price) {
				entry.order_ids.push(order_id);
				return;
			}

			if (entry.signed_price < price) {
				new_entry(entries, i, price, order_id);
				return;
			}
		}

		new_entry(entries, 0, price, order_id);
	}

	function sell(address issuer, uint quantity, uint32 price) external returns(Result memory result) {
		require( msg.sender == address(_parent) && is_order_legal(quantity, price) );

		uint time = now;
		int signed_price = int(price);
		uint remaining_quantity = quantity;

		for (uint i = _ask.length; i > 0; --i) {
			Entry storage entry = _ask[i-1];

			if (entry.signed_price > -signed_price) {
				break;
			}

			for (uint j = 0; j < entry.order_ids.length; ++j) {
				bytes32 order_id = entry.order_ids[j];
				Order storage o = _orders[order_id];

				if ( o.alive ) {
					if ( o.time + _max_order_lifetime > time ) {
						o.alive = false;
						_parent.on_expired(o);
						emit Expired(order_id);
					} else {
						Execution memory e;
						e.time = time;
						e.seller = issuer;
						e.buyer = o.issuer;
						e.price = uint(-entry.signed_price);

						if ( o.quantity <= remaining_quantity ) {
							e.quantity = o.quantity;
							o.alive = false;
						} else {
							o.quantity -= remaining_quantity;
							e.quantity = remaining_quantity;
						}

						remaining_quantity -= e.quantity;

						on_execution(order_id, e);
						_parent.on_sell_execution(o.user_data);
					}
				}

				if (remaining_quantity == 0) {
					return full_exec_result();
				}
			}

			delete _ask[i-1];
			--_ask.length;
		}

		Order memory o;
		o.time = time;
		o.quantity = remaining_quantity;
		o.price = price;
		o.issuer = issuer;
		o.alive = true;
		o.user_data = _parent.get_user_data();
		bytes32 order_id = compute_order_id(o);
		require(_orders[order_id].alive == false); // avoid collision
		_orders[order_id] = o;

		enter_order(_bid, signed_price, order_id);
		emit SellOrder(order_id);

		return in_book_result(o, quantity != remaining_quantity);
	}

	function buy(address issuer, uint quantity, uint32 price) external returns(Result memory result) {
		require( msg.sender == address(_parent) && is_order_legal(quantity, price) );

		uint time = now;
		int signed_price = int(price);
		uint remaining_quantity = quantity;

		for (uint i = _bid.length; i > 0; --i) {
			Entry storage entry = _bid[i-1];

			if (entry.signed_price > signed_price) {
				break;
			}

			for (uint j = 0; j < entry.order_ids.length; ++j) {
				bytes32 order_id = entry.order_ids[j];
				Order storage o = _orders[order_id];

				if ( o.alive ) {
					if ( o.time + _max_order_lifetime > time ) {
						o.alive = false;
						_parent.on_expired(o);
						emit Expired(order_id);
					} else {
						Execution memory e;
						e.time = time;
						e.seller = o.issuer;
						e.buyer = issuer;
						e.price = uint(entry.signed_price);

						if ( o.quantity <= remaining_quantity ) {
							e.quantity = o.quantity;
							o.alive = false;
						} else {
							o.quantity -= remaining_quantity;
							e.quantity = remaining_quantity;
						}

						remaining_quantity -= e.quantity;

						on_execution(order_id, e);
						_parent.on_buy_execution(o.user_data);
					}
				}

				if (remaining_quantity == 0) {
					return full_exec_result();
				}
			}

			delete _bid[i-1];
			--_bid.length;
		}

		Order memory o;
		o.time = time;
		o.quantity = remaining_quantity;
		o.price = price;
		o.issuer = issuer;
		o.alive = true;
		o.user_data = _parent.get_user_data();
		bytes32 order_id = compute_order_id(o);
		require(_orders[order_id].alive == false); // avoid collision
		_orders[order_id] = o;

		enter_order(_ask, -signed_price, order_id);
		emit BuyOrder(order_id);

		return in_book_result(o, quantity != remaining_quantity);
	}

	function cancel(address issuer, bytes32 order_id) external returns(Order memory order) {
		require( msg.sender == address(_parent) );

		Order storage o = _orders[order_id];
		require(o.alive && o.issuer == issuer);
		o.alive = false;
		emit Cancelled(order_id);
		return o;
	}

	function clear() external {
		require( msg.sender == address(_parent) );

		delete _bid;
		delete _ask;
		delete _executions;
	}
}


contract BookFactory is IBookFactory {
	function create(
			uint minimum_order_quantity
		,	uint price_tick_size
		,	uint max_order_lifetime
		) external returns(IBook book)
	{
		return new Book(minimum_order_quantity, price_tick_size, max_order_lifetime);
	}
}
