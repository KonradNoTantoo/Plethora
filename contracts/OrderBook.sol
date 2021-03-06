pragma solidity ^0.5.5;
pragma experimental ABIEncoderV2;


import "Common.sol";


contract IOrderBook {
	event BuyOrder(bytes32 id);
	event SellOrder(bytes32 id);
	event Cancelled(bytes32 id);
	event Hit(bytes32 hit_order, address buyer, address seller, uint price, uint quantity);

	struct Order {
		uint quantity;
		uint price;
		address issuer;
		uint128 alive;
		uint128 is_buy;
	}

	struct Execution {
		uint time;
		uint price;
		uint quantity;
		address buyer;
		address seller;
	}

	struct Entry {
		int signed_price;
		bytes32[] order_ids;
	}

	Entry[] public _bid;
	Entry[] public _ask;
	Execution[] public _executions;
	mapping (bytes32 => Order) public _orders;
	uint public _order_quantity_unit;

	constructor(uint order_quantity_unit) public {
		require(order_quantity_unit > 0);
		_order_quantity_unit = order_quantity_unit;
	}

	function nb_executions() external view returns(uint nb) {
		return _executions.length;
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

	function _sell(uint quantity, uint price) internal returns(uint remaining_quantity) {
		require( _is_order_legal(quantity, price) );

		int signed_price = int(price);
		remaining_quantity = quantity;

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
					e.time = now;
					e.price = uint(-entry.signed_price);
					e.buyer = o.issuer;
					e.seller = msg.sender;

					if ( o.quantity <= remaining_quantity ) {
						e.quantity = o.quantity;
						delete _orders[order_id];
					} else {
						o.quantity -= remaining_quantity;
						e.quantity = remaining_quantity;
					}

					remaining_quantity -= e.quantity;

					_on_execution(order_id, e);
					_on_sell_execution(e.buyer, msg.sender, e.quantity, e.price);
				}

				if (remaining_quantity == 0) {
					return 0;
				}
			}

			delete _ask[i-1];
			--_ask.length;
		}

		Order memory o;
		o.quantity = remaining_quantity;
		o.price = price;
		o.issuer = msg.sender;
		o.alive = 1;
		bytes32 order_id = keccak256(abi.encodePacked(now, msg.sender, price));
		require(_orders[order_id].alive == 0); // avoid collision
		_orders[order_id] = o;

		_enter_order(_bid, signed_price, order_id);
		emit SellOrder(order_id);
	}

	function _buy(uint quantity, uint price) internal returns(uint remaining_quantity) {
		require( _is_order_legal(quantity, price) );

		int signed_price = int(price);
		remaining_quantity = quantity;

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
					e.time = now;
					e.price = uint(entry.signed_price);
					e.buyer = msg.sender;
					e.seller = o.issuer;

					if ( o.quantity <= remaining_quantity ) {
						e.quantity = o.quantity;
						delete _orders[order_id];
					} else {
						o.quantity -= remaining_quantity;
						e.quantity = remaining_quantity;
					}

					remaining_quantity -= e.quantity;

					_on_execution(order_id, e);
					_on_buy_execution(msg.sender, e.seller, e.quantity, e.price);
				}

				if (remaining_quantity == 0) {
					return 0;
				}
			}

			delete _bid[i-1];
			--_bid.length;
		}

		Order memory o;
		o.quantity = remaining_quantity;
		o.price = price;
		o.issuer = msg.sender;
		o.alive = 1;
		o.is_buy = 1;
		bytes32 order_id = keccak256(abi.encodePacked(now, msg.sender, price));
		require(_orders[order_id].alive == 0); // avoid collision
		_orders[order_id] = o;

		_enter_order(_ask, -signed_price, order_id);
		emit BuyOrder(order_id);
	}

	function _cancel(bytes32 order_id) internal returns(Order memory order) {
		order = _orders[order_id];
		require(order.alive == 1 && order.issuer == msg.sender);
		delete _orders[order_id];
		emit Cancelled(order_id);
	}

	function _clear() internal {
		delete _bid;
		delete _ask;
		delete _executions;
	}

	function _on_buy_execution(address buyer, address seller, uint quantity, uint price) internal;
	function _on_sell_execution(address buyer, address seller, uint quantity, uint price) internal;
}
