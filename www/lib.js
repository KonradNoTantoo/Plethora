/*
* TODO
* - explore _options from marketplace at startup
* - cancel orders
* - option actions: sell secondary, exercise, settle, liquidate
* - popup for order passing, book opening, order info (with possible cancel).
* - subscribe to CallEmission and PutEmission
*/

let dapp = null
let contract_addresses = {}

function array_from_storage(name) { const x = localStorage.getItem(name); return x == null ? [] : JSON.parse(x) }

let pinned_call_books = {}
let pinned_call_book_addresses = array_from_storage('pinned_call_book_addresses')
let pinned_put_books = {}
let pinned_put_book_addresses = array_from_storage('pinned_put_book_addresses')

let pinned_call_options = {}
let pinned_call_option_addresses = array_from_storage('pinned_call_option_addresses')
let pinned_put_options = {}
let pinned_put_option_addresses = array_from_storage('pinned_put_option_addresses')


const SECONDS_IN_AN_HOUR = 60*60
const SECONDS_IN_AN_DAY = 24*SECONDS_IN_AN_HOUR
const PRICE_ADJUSTMENT = 2**3
const BOOK_OPENING_FEE = ethers.utils.parseUnits("1", 'finney')
const ADDRESS_ZERO = '0x0000000000000000000000000000000000000000'
const OPTION_STATUS = Object.freeze({
	WAITING: 0,
	RUNNING: 1,
	EXPIRED: 2,
	SETTLED: 3,
	LIQUIDATED: 4
})

Date.prototype.toLabel = function() {
	pad0 = (x) => { return (x>9 ? '' : '0') + x }
	return [this.getUTCFullYear(),
			pad0(this.getUTCMonth() + 1),
			pad0(this.getUTCDate())
		].join('-')
		+ ["\u00A0",
			this.getUTCHours(),
			':',
			pad0(this.getUTCMinutes())
		].join('')
}

Array.prototype.asyncForEach = async function (callback) {
	const promises = []
	for (let index = 0; index < this.length; index++) {
		promises.push(callback(this[index], index, this))
	}
	await Promise.all(promises)
}

function now() { return Math.floor(Date.now()/1000) }
function adjust_price(p) { return ethers.utils.bigNumberify(Math.floor(p*PRICE_ADJUSTMENT)) }
function display_price(p, precision = 3) { return parseFloat(p.toNumber()/PRICE_ADJUSTMENT).toFixed(precision) }
function nominal_value(q, p) { return p.mul(q).div(PRICE_ADJUSTMENT) }

function show_error(message, console_message = "") {
	console.error(message)
	if ( console_message != "" ) { console.error(console_message) }
}

function loadJSON(url) {
	return new Promise(function (resolve, reject) {
		let xhr = new XMLHttpRequest()
		xhr.overrideMimeType("application/json")
		xhr.open("GET", url)
		xhr.onload = function () {
			if ( this.status >= 200 && this.status < 300 ) {
				resolve( JSON.parse(xhr.response) );
			} else {
				reject({
					status: this.status,
					statusText: xhr.statusText
				})
			}
		}
		xhr.onerror = function () {
			reject({
				status: this.status,
				statusText: xhr.statusText
			})
		}
		xhr.send()
	})
}

function hide(id) {
	document.getElementById(id).style.display = 'none'
}

function show(id) {
	document.getElementById(id).style.display = 'block'
}

function html_value(id) {
	return document.getElementById(id).value
}

function remove_element(id)
{
	const element = document.getElementById(id);
	const parent = element.parentNode
	parent.removeChild(element);
	return parent
}

function remove_all_children(id) {
	const node = document.getElementById(id);
	if ( node ) {
		while ( node.firstChild ) {
			node.removeChild(node.firstChild);
		}
	}
	return node
}

function book_node_id(book_address) {
	return ['B', book_address].join('')
}

function order_node_id(book_address, order_id) {
	return ['O', book_address, '-', order_id].join('')
}

function option_node_id(contract_address) {
	return ['X', contract_address].join('')
}

function option_label(strike, expiry_in_seconds) {
	const expiry_date = new Date(expiry_in_seconds*1000)
	return [display_price(ethers.utils.bigNumberify(strike)), "\u2014\u00A0", expiry_date.toLabel()].join('\u00A0')
}

function dapp_is_on() { return dapp !== null }

function set_book_callbacks(expiry, strike, book_contract, market_contract) {
	book_contract.on("BuyOrder", (id, event) => {
		console.log("BuyOrder", id)
		refresh_pinned_book(expiry, strike, book_contract, market_contract)
	})
	book_contract.on("SellOrder", (id, event) => {
		console.log("SellOrder", id)
		refresh_pinned_book(expiry, strike, book_contract, market_contract)
	})
	book_contract.on("Expired", (id, event) => {
		console.log("Expired", id)
		remove_element(order_node_id(book_contract.address, id))
	})
	book_contract.on("Cancelled", (id, event) => {
		console.log("Cancelled", id)
		remove_element(order_node_id(book_contract.address, id))
	})
	book_contract.on("Hit", (hit_order, buyer, seller, price, quantity, user_data, event) => {
		console.log("Hit", buyer, seller, display_price(price), quantity.toString())
		refresh_pinned_book(expiry, strike, book_contract, market_contract)
		if ( seller.toLowerCase() == dapp.address ) {
			on_sold(hit_order, buyer, seller, price, quantity, user_data, book_contract, market_contract, expiry, strike)
		} else if ( buyer.toLowerCase() == dapp.address ) {
			on_bought(hit_order, buyer, seller, price, quantity, user_data, book_contract, market_contract, expiry, strike)
		}
	})
}

async function restore_pinned_books(addresses, pinned, market_contract) {
	await addresses.asyncForEach(async (book_address) => {
		const book_data = await market_contract._book_data(book_address)
		const expiry = book_data.expiry.toNumber()
		const strike = book_data.strike_per_underlying_unit.toString()

		if ( !(expiry in pinned) ) {
			pinned[expiry] = {}
		}

		const book_contract = new ethers.Contract(book_address, dapp.book_abi, dapp.provider.getSigner())
		set_book_callbacks(expiry, strike, book_contract, market_contract)
		pinned[expiry][strike] = book_contract
		console.log("Restored book:", book_address)
	})
}

async function restore_pinned_call_books() {
	await restore_pinned_books(pinned_call_book_addresses, pinned_call_books, dapp.call_contract)
}

async function restore_pinned_put_books() {
	await restore_pinned_books(pinned_put_book_addresses, pinned_put_books, dapp.put_contract)
}

async function restore_pinned_options(addresses, pinned, abi, market_contract) {
	await addresses.asyncForEach(async (option_address) => {
		option_contract = new ethers.Contract(option_address, abi, dapp.provider.getSigner())
		let [expiry, strike] = await Promise.all([option_contract._expiry(), option_contract._strike_per_underlying_unit()])
		expiry = expiry.toNumber()
		strike = strike.toString()

		if ( !(expiry in pinned) ) {
			pinned[expiry] = {}
		}

		pinned[expiry][strike] = option_contract
		console.log("Restored option:", option_address)
	})
}

async function restore_pinned_call_options() {
	await restore_pinned_options(pinned_call_option_addresses, pinned_call_options, dapp.call_option_abi, dapp.call_contract)
}

async function restore_pinned_put_options() {
	await restore_pinned_options(pinned_put_option_addresses, pinned_put_options, dapp.put_option_abi, dapp.put_contract)
}

async function initialize_connection(address, provider) {
	const [network, contracts] = await Promise.all([provider.getNetwork(), loadJSON('contract_addresses.json')])
	contract_addresses = contracts

	if ( network.name in contract_addresses ) {
		address = address.toLowerCase()
		const addresses =  contract_addresses[network.name]
		const call_market_abi = await loadJSON("call_market_abi.json")
		const put_market_abi = await loadJSON("put_market_abi.json")
		const call_option_abi = await loadJSON("call_option_abi.json")
		const put_option_abi = await loadJSON("put_option_abi.json")
		const book_abi = await loadJSON("book_abi.json")
		const erc20_abi = await loadJSON("erc20_abi.json")
		const call_contract = new ethers.Contract(addresses.call, call_market_abi, provider.getSigner())
		const put_contract = new ethers.Contract(addresses.put, put_market_abi, provider.getSigner())
		const erc20_contract = new ethers.Contract(addresses.erc20, erc20_abi, provider.getSigner())

		dapp = {
			address,
			provider,
			call_contract,
			put_contract,
			erc20_contract,
			book_abi,
			call_option_abi,
			put_option_abi
		}

		await Promise.all([
				restore_pinned_call_books()
			,	restore_pinned_put_books()
			,	restore_pinned_call_options()
			,	restore_pinned_put_options()
			])
		console.log("Dapp is ready on network " + network.name)
	} else {
		show_error("Not available on network " + network.name)
	}
}

function exec_nominal_to_html(nominal) {
	const node = document.createElement('span')
	node.appendChild(document.createTextNode(nominal.toString()))
	return node
}

function exec_shares_to_html(option_contract_address, expiry, strike) {
	const node = document.createElement('span')
	node.appendChild(document.createTextNode(option_label(strike, expiry)))
	const option_address_node = document.createElement('span')
	option_address_node.class = 'address'
	node.append(option_address_node)
	return node
}

function display_execution(nominal_node, shares_node) {
	const node = document.createElement('div')
	node.className = 'execution'
	node.appendChild(nominal_node)
	node.appendChild(shares_node)
	document.getElementById('executions-contents').prepend(	node )
}

async function on_sold(hit_order, buyer, seller, price, quantity, user_data, book_contract, market_contract, expiry, strike) {
	option_contract_address = user_data

	if ( option_contract_address === ADDRESS_ZERO ) {
		const order = await book_contract.get_order(hit_order)
		option_contract_address = order.user_data
	}

	add_option_contract(option_contract_address, market_contract, expiry, strike)

	const nominal_node = exec_nominal_to_html(quantity, price)
	const shares_node = exec_shares_to_html(option_contract_address, expiry, strike)

	nominal_node.className = 'received'
	shares_node.className = 'relinquished'

	display_execution(nominal_node, shares_node)
}

async function on_bought(hit_order, buyer, seller, price, quantity, user_data, book_contract, market_contract, expiry, strike) {
	option_contract_address = user_data

	if ( option_contract_address === ADDRESS_ZERO ) {
		const order = await book_contract.get_order(hit_order)
		option_contract_address = order.user_data
	}

	add_option_contract(option_contract_address, market_contract, expiry, strike)

	const nominal_node = exec_nominal_to_html(quantity, price)
	const shares_node = exec_shares_to_html(option_contract_address, expiry, strike)

	nominal_node.className = 'relinquished'
	shares_node.className = 'received'

	display_execution(nominal_node, shares_node)
}

function option_class(status, expiry) {
	if ( status == OPTION_STATUS.WAITING ) {
		return 'option-waiting'
	}

	if ( status == OPTION_STATUS.RUNNING ) {
		if ( expiry - now() < SECONDS_IN_AN_HOUR ) {
			return 'option-expiring'
		}

		return 'option-running'
	}

	if ( status == OPTION_STATUS.EXPIRED ) {
		return 'option-expired'
	}

	if ( status == OPTION_STATUS.SETTLED ) {
		return 'option-settled'
	}

	if ( status == OPTION_STATUS.LIQUIDATED ) {
		return 'option-liquidated'
	}

	show_error("Unknown option contract status")
}

async function option_content_to_html(node, option_contract, market_contract, expiry, strike) {
	const [status, balance] = await Promise.all([option_contract.getStatus(), option_contract.balanceOf(dapp.address)])

	const label_node = document.createElement('div')
	label_node.className = option_class(status, expiry)
	label_node.appendChild(document.createTextNode(option_label(strike, expiry)))

	const address_node = document.createElement('div')
	address_node.className = 'address'
	address_node.appendChild(document.createTextNode(option_contract.address))

	const balance_node = document.createElement('div')
	balance_node.className = 'balance'
	balance_node.appendChild(document.createTextNode(ethers.utils.formatEther(balance)))

	node.appendChild(label_node)
	node.appendChild(address_node)
	node.appendChild(balance_node)
	return node
}

async function option_to_html(option_contract, market_contract, expiry, strike) {
	const node_id = option_node_id( option_contract.address )
	let node = remove_all_children( node_id )

	if ( ! node ) {
		node = document.createElement('div')
		node.id = node_id

		if ( market_contract === dapp.call_contract ) {
			node.className = 'call'
		} else if ( market_contract === dapp.put_contract ) {
			node.className = 'put'
		} else {
			show_error("Bad instrument type")
			return
		}
	}

	return await option_content_to_html(node, option_contract, market_contract, expiry, strike)
}

async function display_option(option_contract, market_contract, expiry, strike) {
	const node = await option_to_html(option_contract, market_contract, expiry, strike)
	if ( market_contract === dapp.call_contract ) {
		document.getElementById('call-contents').appendChild(node)
	} else if ( market_contract === dapp.put_contract ) {
		document.getElementById('put-contents').appendChild(node)
	} else {
		show_error("Bad instrument type")
	}
}

function get_option_contract(option_contract_address, market_contract) {
	let option_contract

	if ( market_contract === dapp.call_contract ) {
		option_contract = new ethers.Contract(option_contract_address, dapp.call_option_abi, dapp.provider.getSigner())
	} else if ( market_contract === dapp.put_contract ) {
		option_contract = new ethers.Contract(option_contract_address, dapp.put_option_abi, dapp.provider.getSigner())
	} else {
		show_error("Bad instrument type")
	}

	return option_contract
}

function add_option_to_pinned(option_contract, market_contract, expiry, strike) {
	let pinned, addresses, storage

	if ( market_contract === dapp.call_contract ) {
		pinned = pinned_call_options
		addresses = pinned_call_option_addresses
		storage = 'pinned_call_option_addresses'
	} else if ( market_contract === dapp.put_contract ) {
		pinned = pinned_put_options
		addresses = pinned_put_option_addresses
		storage = 'pinned_put_option_addresses'
	} else {
		show_error("Uknown contract")
		return
	}

	if ( !(expiry in pinned) ) {
		pinned[expiry] = {}
	} else if (strike in pinned[expiry]) {
		return
	}

	pinned[expiry][strike] = option_contract
	addresses.push(option_contract.address)
	localStorage.setItem(storage, JSON.stringify(addresses))
	console.log("Pinned contract:", option_contract.address)
}

function refresh_option_contract(option_contract_address, market_contract, expiry, strike) {
	const option_contract = get_option_contract(option_contract_address, market_contract)
	display_option(option_contract, market_contract, expiry, strike)
}

function display_pinned_options(node, pinned, market_contract) {
	for ( var expiry in pinned ) {
		const tmp = pinned[expiry]
		for ( var strike in tmp ) {
			display_option(tmp[strike], market_contract, expiry, strike)
		}
	}
}

function refresh_pinned_call_options() {
	display_pinned_options( remove_all_children('call-contents'), pinned_call_options, dapp.call_contract )
}

function refresh_pinned_put_options() {
	display_pinned_options( remove_all_children('put-contents'), pinned_put_options, dapp.put_contract )
}

function add_option_contract(option_contract_address, market_contract, expiry, strike) {
	const option_contract = get_option_contract(option_contract_address, market_contract)
	display_option(option_contract, market_contract, expiry, strike)
	add_option_to_pinned(option_contract, market_contract, expiry, strike)
}

async function evaluate_option_contract(option_contract_address, market_contract, expiry, strike) {
	const option_contract = get_option_contract(option_contract_address, market_contract)

	if ( false == (await option_contract.balanceOf(dapp.address)).isZero() || dapp.address == await option_contract._writer() ) {
		display_option(option_contract, market_contract, expiry, strike)
		add_option_to_pinned(option_contract, market_contract, expiry, strike)
	}
}

function book_class(expiry) {
	const time = now()

	if ( expiry <= time ) {
		return 'expired-book'
	} else if ( expiry - time < SECONDS_IN_AN_HOUR ) {
		return 'expiring-book'
	}

	return 'active-book'
}

function order_form(node_id, min_qty) {
	return [
			"<select id='", node_id, "-way'><option value='B'>Buy</option><option value='S'>Sell</option></select>",
			"<input id='", node_id, "-qty' type='number' step='0.0001' min='", min_qty, "'>",
			"@<input id='", node_id, "-px' type='number' step='0.125' min='0.125'>"
		].join('')
}

function book_side_node(side, title) {
	const node = document.createElement('div')
	node.className = side
	const title_node = document.createElement('p')
	title_node.appendChild(document.createTextNode(title))
	node.appendChild(title_node)
	return node
}

async function book_content_to_html(book_node, expiry, strike, book_contract, market_contract) {
	const title_node = document.createElement('h5')
	title_node.appendChild(document.createTextNode(option_label(strike, expiry)))
	title_node.className = book_class(expiry)
	book_node.appendChild(title_node)

	if ( title_node.className != 'expired-book') {
		const bid_node = book_side_node('bid', 'Bid')
		const ask_node = book_side_node('ask', 'Ask')

		let [bid_size, ask_size, lifetime] =
			await Promise.all([book_contract.bid_size(), book_contract.ask_size(), book_contract._max_order_lifetime()])
		bid_size = bid_size.toNumber()
		ask_size = ask_size.toNumber()
		lifetime = lifetime.toNumber()
		let bid_entries = []
		let ask_entries = []

		for ( var i = 0; i < bid_size; ++i ) {
			bid_entries.push(book_contract.bid_entries(i))
		}

		for ( var i = 0; i < ask_size; ++i ) {
			ask_entries.push(book_contract.ask_entries(i))
		}

		bid_entries = await Promise.all(bid_entries)
		ask_entries = await Promise.all(ask_entries)

		bid_entries.asyncForEach( async (e, index) => {
			const entry_node = document.createElement('div')
			bid_node.appendChild(entry_node)

			for ( var i = 0; i < e.size; ++i ) {
				const order_node = document.createElement('div')
				book_contract.bid_order(index, i).then( (order_id) => {
					book_contract.get_order(order_id).then( (order) => {
						if ( order.alive && order.time + lifetime ) {
							entry_node.appendChild(order_node)
							order_node.appendChild(document.createTextNode([
								ethers.utils.formatEther(order.quantity),
								display_price(order.price)
							].join('\u00A0')))
							if ( order.issuer.toLowerCase() == dapp.address ) {
								order_node.className = 'owned-order'
								if ( order.user_data != ADDRESS_ZERO ) {
									add_option_contract( order.user_data, market_contract, expiry, strike )
								}
							} else if ( order.user_data != ADDRESS_ZERO ) {
								evaluate_option_contract( order.user_data, market_contract, expiry, strike )
							}
							order_node.id = order_node_id(book_contract.address, order_id)
						}
					})
				})
			}
		})

		ask_entries.asyncForEach( async (e, index) => {
			const entry_node = document.createElement('div')
			ask_node.appendChild(entry_node)

			for ( var i = 0; i < e.size; ++i ) {
				const order_node = document.createElement('div')
				book_contract.ask_order(index, i).then( (order_id) => {
					book_contract.get_order(order_id).then( (order) => {
						if ( order.alive && order.time + lifetime ) {
							entry_node.appendChild(order_node)
							order_node.appendChild(document.createTextNode([
								display_price(order.price),
								ethers.utils.formatEther(order.quantity)
							].join('\u00A0')))
							if ( order.issuer.toLowerCase() == dapp.address ) {
								order_node.className = 'owned-order'
							}
							order_node.id = order_node_id(book_contract.address, order_id)
						}
					})
				})
			}
		})

		book_node.appendChild(bid_node)
		book_node.appendChild(ask_node)

		let minimum_order_quantity = await book_contract._minimum_order_quantity()
		minimum_order_quantity = ethers.utils.formatEther(minimum_order_quantity)

		const order_node = document.createElement('div')
		order_node.id = book_node.id + '-order-form'
		order_node.className = 'order-form'
		order_node.innerHTML = order_form(book_node.id, minimum_order_quantity)
		const order_button = document.createElement('button')
		order_button.innerHTML = "place"
		order_button.onclick = () => {
			place_order(market_contract,
				book_contract.address,
				book_node.id,
				ethers.utils.bigNumberify(strike))
		}
		order_node.append(order_button)
		book_node.appendChild(order_node)

		const wait_node = document.createElement('div')
		wait_node.id = book_node.id + '-order-wait'
		wait_node.className = 'wait'
		book_node.appendChild(wait_node)
	}

	return book_node
}

async function book_to_html(expiry, strike, book_contract, market_contract) {
	const book_node = document.createElement('div')
	book_node.id = book_node_id(book_contract.address)
	book_node.className = 'book'
	return book_content_to_html(book_node, expiry, strike, book_contract, market_contract)
}

async function display_pinned_books(node, pinned, contract) {
	for ( var expiry in pinned ) {
		const tmp = pinned[expiry]
		for ( var strike in tmp ) {
			node.appendChild(await book_to_html(expiry, strike, tmp[strike], contract))
		}
	}
}

function refresh_pinned_book(expiry, strike, book_contract, market_contract) {
	book_content_to_html(
		remove_all_children(book_node_id(book_contract.address)),
		expiry, strike, book_contract, market_contract)
}

async function refresh_pinned_call_books() {
	await display_pinned_books( remove_all_children('call-books-pinned'), pinned_call_books, dapp.call_contract )
}

async function refresh_pinned_put_books() {
	await display_pinned_books( remove_all_children('put-books-pinned'), pinned_put_books, dapp.put_contract )
}

async function add_book_to_pinned(pinned, market_contract, expiry, strike) {
	if ( !(expiry in pinned) ) {
		pinned[expiry] = {}
	} else if (strike in pinned[expiry]) {
		return null
	}

	const book_address = await market_contract.get_book_address(expiry, strike)
	const book_contract = new ethers.Contract(book_address, dapp.book_abi, dapp.provider.getSigner())
	set_book_callbacks(expiry, strike, book_contract, market_contract)
	pinned[expiry][strike] = book_contract
	return book_address
}

async function pin_book(contract, expiry, strike) {
	if ( contract === dapp.call_contract ) {
		const address = await add_book_to_pinned(pinned_call_books, contract, expiry, strike)
		if ( address != null ) {
			refresh_pinned_call_books()
			pinned_call_book_addresses.push(address)
			localStorage.setItem('pinned_call_book_addresses', JSON.stringify(pinned_call_book_addresses))
		}
	} else if ( contract === dapp.put_contract ) {
		const address = await add_book_to_pinned(pinned_put_books, contract, expiry, strike)
		if ( address != null ) {
			refresh_pinned_put_books()
			pinned_put_book_addresses.push(address)
			localStorage.setItem('pinned_put_book_addresses', JSON.stringify(pinned_put_book_addresses))
		}
	} else {
		show_error("Uknown contract")
	}
}

async function display_known_books(node, contract, max_depth) {
	const nb_books = await contract.nb_books()
	const limit = Math.min(max_depth, nb_books)

	for (var i = 1; i <= limit; ++i) {
		const book_address = await contract._book_addresses(nb_books - i)
		const book_data = await contract._book_data(book_address)

		const expiry_in_seconds = book_data.expiry.toNumber()
		const strike_str = book_data.strike_per_underlying_unit.toString()
		const book_node = document.createElement('p')
		book_node.appendChild(document.createTextNode(option_label(strike_str, expiry_in_seconds)))
		book_node.className = book_class(expiry_in_seconds)

		if ( book_node.className != 'expired-book' ) {
			const pin_button = document.createElement('button')
			pin_button.onclick = () => {
				pin_book(contract,
					expiry_in_seconds,
					strike_str)
				}
			pin_button.innerHTML = "pin"
			book_node.appendChild(pin_button)
		}

		node.appendChild(book_node)
	}
}

function refresh_pinned_books() {
	refresh_pinned_call_books()
	refresh_pinned_put_books()
}

function refresh_known_call_books() {
	const depth = parseInt(html_value('book-search-depth'))
	const call_node = remove_all_children('call-books-known')
	display_known_books(call_node, dapp.call_contract, depth)
}

function refresh_known_put_books() {
	const depth = parseInt(html_value('book-search-depth'))
	const put_node = remove_all_children('put-books-known')
	display_known_books(put_node, dapp.put_contract, depth)
}

function refresh_known_books() {
	const depth = parseInt(html_value('book-search-depth'))
	const call_node = remove_all_children('call-books-known')
	const put_node = remove_all_children('put-books-known')

	display_known_books(call_node, dapp.call_contract, depth)
	display_known_books(put_node, dapp.put_contract, depth)
}

function refresh_books() {
	refresh_known_books()
	refresh_pinned_books()
}

function refresh_executions() {

}

function refresh_contracts() {
	refresh_pinned_call_options()
	refresh_pinned_put_options()
}

function refresh_view() {
	if ( dapp_is_on() ) {
		hide('intro')
		hide('connection-form')
		hide('connection-wait')
		show('header')
		show('books')
		show('executions')
		show('contracts')

		refresh_books()
		refresh_executions()
		refresh_contracts()

		dapp.call_contract.on("BookOpened", (book_address, expiry, strike, event) => {
			console.log("Call book opened", book_address, expiry.toString(), display_price(strike))
			refresh_pinned_call_books()
		})
		dapp.put_contract.on("BookOpened", (book_address, expiry, strike, event) => {
			console.log("Put book opened", book_address, expiry.toString(), display_price(strike))
			refresh_pinned_put_books()
		})
	} else {
		show('intro')
		show('connection-form')
		hide('connection-wait')
		hide('header')
		hide('books')
		hide('executions')
		hide('contracts')
	}
}

function initiatilize_view() {
	refresh_view()
}

async function connect_metamask() {
	hide('connection-form')
	show('connection-wait')

	try {
		const [address] = await ethereum.enable()
		const provider = new ethers.providers.Web3Provider(ethereum)
		await initialize_connection(address, provider)
	} catch( err ) {
		dapp = null
		show_error("Wallet connection problem", err)
	}

	refresh_view()
}

async function open_book() {
	const instrument_type = html_value('openbook-type')
	let contract = null

	if ( instrument_type == 'call' ) {
		contract = dapp.call_contract
	} else if ( instrument_type == 'put' ) {
		contract = dapp.put_contract
	} else {
		show_error("Bad instrument type")
		return
	}

	hide('openbook-form')
	show('openbook-wait')

	try
	{
		const expiry = Math.floor(new Date(html_value('openbook-expiry') + "T14:00Z").getTime()/1000)
		const strike = adjust_price( html_value('openbook-strike') )
		const minqty = ethers.utils.parseEther( html_value('openbook-minqty') )
		const orderlife = html_value('openbook-orderlife') * SECONDS_IN_AN_HOUR

		console.assert(expiry - now() >= SECONDS_IN_AN_DAY)
		console.assert(orderlife >= SECONDS_IN_AN_DAY)

		console.log("Opening book: ", expiry, strike.toString(), minqty.toString(), orderlife)

		const tx = await contract.open_book(expiry, strike, minqty, orderlife, {value: BOOK_OPENING_FEE})
		await tx.wait()
	} catch( err ) {
		show_error("Open book transaction error", err)
	}

	show('openbook-form')
	hide('openbook-wait')
}

async function place_order(market_contract, book_address, book_node_id, strike) {
	hide(book_node_id + '-order-form')
	show(book_node_id + '-order-wait')

	let quantity = html_value(book_node_id + '-qty')
	let price = html_value(book_node_id + '-px')
	const way = html_value(book_node_id + '-way')

	console.log("Placing order", way, quantity, "ETH @", price, "DAI/ETH")

	quantity = ethers.utils.parseEther( quantity )
	price = adjust_price( price )

	console.log("\t ( Wired order", way, quantity.toString(), "wei @", price.toString(), "adjusted price )")

	try {
		if ( way === 'B') {
			const tx = await dapp.erc20_contract.approve(market_contract.address, nominal_value(quantity, price))
			await tx.wait()
			await market_contract.buy(book_address, quantity, price)
		} else if ( way === 'S') {
			if ( market_contract === dapp.call_contract ) {
				await market_contract.sell(book_address, price, {value: quantity})
			} else if ( market_contract === dapp.put_contract ) {
				const tx = await dapp.erc20_contract.approve(market_contract.address, nominal_value(quantity, strike))
				await tx.wait()
				await market_contract.sell(book_address, quantity, price)
			}
		} else {
			show_error("Unknown order way")
		}
	} catch( err ) {
		show_error("Cannot place order", err)
	}

	// dapp.erc20_contract.approve(market_contract.address, 0)

	show(book_node_id + '-order-form')
	hide(book_node_id + '-order-wait')
}