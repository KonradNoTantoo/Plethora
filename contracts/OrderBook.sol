pragma solidity ^0.5.5;
pragma experimental ABIEncoderV2;


import "Common.sol";


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
	uint public _order_quantity_unit;

	IBookOwner public _owner;

	constructor(
			IBookOwner owner
		,	uint order_quantity_unit
		) public {
		require(order_quantity_unit > 0);
		_order_quantity_unit = order_quantity_unit;
		_owner = owner;
	}

	function _full_exec_result() internal pure returns(Result memory full_exec) {
		Result memory result;
		result.status = Status.FULL_EXEC;
		return result;
	}

	function _in_book_result(Order memory order, bool partial_exec) internal pure returns(Result memory in_book) {
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

	function bid_size() external view returns(uint size) {
		return _bid.length;
	}

	function ask_size() external view returns(uint size) {
		return _ask.length;
	}

	function bid_entries(uint index) external view returns(int signed_price, uint size) {
		Entry memory e = _bid[index];
		return (e.signed_price, e.order_ids.length);
	}

	function ask_entries(uint index) external view returns(int signed_price, uint size) {
		Entry memory e = _ask[index];
		return (e.signed_price, e.order_ids.length);
	}

	function bid_order(uint entry, uint position) external view returns(bytes32 order_id) {
		return _bid[entry].order_ids[position];
	}

	function ask_order(uint entry, uint position) external view returns(bytes32 order_id) {
		return _ask[entry].order_ids[position];
	}

	function _is_order_legal(uint quantity, uint price) internal view returns(bool legal) {
		return (quantity % _order_quantity_unit) == 0
			&& PriceLib.is_valid_nominal(quantity, price);
	}

	function is_order_legal(uint quantity, uint price) external view returns(bool legal) {
		return _is_order_legal(quantity, price);
	}

	function _compute_order_id(Order memory order) internal pure returns (bytes32 id) {
		return keccak256(abi.encodePacked(order.time, order.issuer, order.price));
	}

	function _new_entry(Entry[] storage entries, uint index, int price, bytes32 order_id) internal {
		++entries.length;

		for(uint i = entries.length - 1; i > index; --i) {
			entries[i] = entries[i-1];
		}

		Entry storage e = entries[index];
		e.signed_price = price;
		delete e.order_ids;
		e.order_ids.push(order_id);
	}

	function _on_execution(bytes32 hit_order, Execution memory exec) internal {
		_executions.push(exec);
		emit Hit(hit_order, exec.buyer, exec.seller, exec.price, exec.quantity);
	}

	function _enter_order(Entry[] storage entries, int price, bytes32 order_id) internal {
		for (uint i = entries.length; i > 0; --i) {
			Entry storage entry = entries[i-1];

			if (entry.signed_price == price) {
				entry.order_ids.push(order_id);
				return;
			}

			if (entry.signed_price > price) {
				_new_entry(entries, i, price, order_id);
				return;
			}
		}

		_new_entry(entries, 0, price, order_id);
	}

	function sell(address issuer, uint quantity, uint price) external returns(Result memory result) {
		require( msg.sender == address(_owner) && _is_order_legal(quantity, price) );

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

				if ( o.alive == 1 ) {
					Execution memory e;
					e.time = time;
					e.seller = issuer;
					e.buyer = o.issuer;
					e.price = uint(-entry.signed_price);

					if ( o.quantity <= remaining_quantity ) {
						e.quantity = o.quantity;
						o.alive = 0;
					} else {
						o.quantity -= remaining_quantity;
						e.quantity = remaining_quantity;
					}

					remaining_quantity -= e.quantity;

					_on_execution(order_id, e);
					_owner.on_sell_execution(e);
				}

				if (remaining_quantity == 0) {
					return _full_exec_result();
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
		o.alive = 1;
		bytes32 order_id = _compute_order_id(o);
		require(_orders[order_id].alive == 0); // avoid collision
		_orders[order_id] = o;

		_enter_order(_bid, signed_price, order_id);
		emit SellOrder(order_id);

		return _in_book_result(o, quantity != remaining_quantity);
	}

	function buy(address issuer, uint quantity, uint price) external returns(Result memory result) {
		require( msg.sender == address(_owner) && _is_order_legal(quantity, price) );

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

				if ( o.alive == 1 ) {
					Execution memory e;
					e.time = time;
					e.seller = o.issuer;
					e.buyer = issuer;
					e.price = uint(entry.signed_price);

					if ( o.quantity <= remaining_quantity ) {
						e.quantity = o.quantity;
						o.alive = 0;
					} else {
						o.quantity -= remaining_quantity;
						e.quantity = remaining_quantity;
					}

					remaining_quantity -= e.quantity;

					_on_execution(order_id, e);
					_owner.on_buy_execution(e);
				}

				if (remaining_quantity == 0) {
					return _full_exec_result();
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
		o.alive = 1;
		o.is_buy = 1;
		bytes32 order_id = _compute_order_id(o);
		require(_orders[order_id].alive == 0); // avoid collision
		_orders[order_id] = o;

		_enter_order(_ask, -signed_price, order_id);
		emit BuyOrder(order_id);

		return _in_book_result(o, quantity != remaining_quantity);
	}

	function cancel(address issuer, bytes32 order_id) external returns(Order memory order) {
		Order storage o = _orders[order_id];
		require(
				o.alive == 1 && o.issuer == issuer
			&&	msg.sender == address(_owner)
			);
		o.alive = 0;
		emit Cancelled(order_id);
		return o;
	}

	function clear() external {
		require( msg.sender == address(_owner) );

		delete _bid;
		delete _ask;
		delete _executions;
	}
}


contract BookFactory is IBookFactory {
	function create(uint order_quantity_unit) external returns(IBook book)
	{
		return new Book(IBookOwner(msg.sender), order_quantity_unit);
	}
}
