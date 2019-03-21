pragma solidity ^0.5.5;
pragma experimental ABIEncoderV2;


interface IMarketPlace {
	function on_execution(bytes20 user_data) external;
	function on_expired(uint quantity, bytes20 user_data) external;
	function get_user_data() external returns(bytes20 user_data);
}


contract Book {
	event BuyOrder(bytes32 id);
	event SellOrder(bytes32 id);
	event Expired(bytes32 id);
	event Cancelled(bytes32 id);
	event Hit(bytes32 hit_order, address buyer, address seller, uint price, uint quantity);

	enum Status { BOOKED, PARTIAL_EXEC, FULL_EXEC }

	struct Order {
		uint time;
		uint quantity;
		address issuer;
		bool alive;
		bytes20 user_data;
	}

	struct Entry {
		int price;
		bytes32[] order_ids;
	}

	struct Execution {
		uint time;
		uint price;
		uint quantity;
		address buyer;
		address seller;
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

	function last_execution() public view returns(Execution memory last) {
		return _executions[_executions.length-1];
	}

	function get_order(bytes32 order_id) public view returns(Order memory gotten) {
		return _orders[order_id];
	}

	function is_order_legal(uint quantity, uint32 price) public view returns(bool legal) {
		return quantity >= _minimum_order_quantity && price % _price_tick_size == 0;
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
		e.price = price;
		delete e.order_ids;
		e.order_ids.push(order_id);
	}

	function on_execution(Execution memory exec, bytes32 hit_order, bytes20 user_data) internal {
		_executions.push(exec);
		_parent.on_execution(user_data);
		emit Hit(hit_order, exec.buyer, exec.seller, exec.price, exec.quantity);
	}

	function enter_order(Entry[] storage entries, int price, bytes32 order_id) internal {
		for (uint i = entries.length; i > 0; --i) {
			Entry storage entry = entries[i-1];

			if (entry.price == price) {
				entry.order_ids.push(order_id);
				return;
			}

			if (entry.price < price) {
				new_entry(entries, i, price, order_id);
				return;
			}
		}

		new_entry(entries, 0, price, order_id);
	}

	function evaluate_hit(bytes32 order_id, uint price, uint quantity, uint time) internal returns(uint remaining_quantity) {
		Order storage o = _orders[order_id];

		if ( o.alive ) {
			if ( o.time + _max_order_lifetime > time ) {
				o.alive = false;

				if ( o.user_data != bytes20(0) ) {
					_parent.on_expired(o.quantity, o.user_data);
				}

				emit Expired(order_id);
			} else {
				Execution memory e;
				e.time = time;
				e.seller = o.issuer;
				e.buyer = issuer;
				e.price = price;

				if ( o.quantity <= quantity ) {
					e.quantity = o.quantity;
					o.alive = false;
				} else {
					o.quantity -= quantity;
					e.quantity = quantity;
				}

				quantity -= e.quantity;
				on_execution(e, order_id, o.user_data);
			}
		}

		return quantity;
	}

	function sell(address issuer, uint quantity, uint32 price) external returns(Status status) {
		require( is_order_legal(quantity, price) );
		uint time = now;
		int signed_price = int(price);
		uint remaining_quantity = quantity;

		for (uint i = _ask.length; i > 0; --i) {
			Entry storage entry = _ask[i-1];

			if (entry.price > -signed_price) {
				break;
			}

			for (uint j = 0; j < entry.order_ids.length; ++j) {
				remaining_quantity =
					evaluate_hit(entry.order_ids[j], uint(-entry.price), remaining_quantity, time);

				if (remaining_quantity == 0) {
					return Status.FULL_EXEC;
				}
			}

			delete _ask[i-1];
			--_ask.length;
		}

		Order memory o;
		o.time = time;
		o.quantity = remaining_quantity;
		o.issuer = issuer;
		o.alive = true;
		o.user_data = _parent.get_user_data();
		bytes32 order_id = compute_order_id(o);
		require(_orders[order_id].alive == false); // avoid collision
		_orders[order_id] = o;

		enter_order(_bid, signed_price, order_id);
		emit SellOrder(order_id);

		return quantity != remaining_quantity ? Status.PARTIAL_EXEC : Status.BOOKED;
	}

	function buy(address issuer, uint quantity, uint32 price) external returns(Status status) {
		require( is_order_legal(quantity, price) );
		uint time = now;
		int signed_price = int(price);
		uint remaining_quantity = quantity;

		for (uint i = _bid.length; i > 0; --i) {
			Entry storage entry = _bid[i-1];

			if (entry.price > signed_price) {
				break;
			}

			for (uint j = 0; j < entry.order_ids.length; ++j) {
				remaining_quantity =
					evaluate_hit(entry.order_ids[j], uint(entry.price), remaining_quantity, time);

				if (remaining_quantity == 0) {
					return Status.FULL_EXEC;
				}
			}

			delete _bid[i-1];
			--_bid.length;
		}

		Order memory o;
		o.time = time;
		o.quantity = remaining_quantity;
		o.issuer = issuer;
		o.alive = true;
		o.user_data = _parent.get_user_data();
		bytes32 order_id = compute_order_id(o);
		require(_orders[order_id].alive == false); // avoid collision
		_orders[order_id] = o;

		enter_order(_ask, -signed_price, order_id);
		emit BuyOrder(order_id);

		return quantity != remaining_quantity ? Status.PARTIAL_EXEC : Status.BOOKED;
	}

	function cancel(address issuer, bytes32 order_id) external returns(Order memory order) {
		Order storage o = _orders[order_id];
		require(o.alive && o.issuer == issuer);
		o.alive = false;
		emit Cancelled(order_id);
		return o;
	}

	function clear() external {	
		delete _bid;
		delete _ask;
		delete _executions;
		delete _orders;
	}
}
