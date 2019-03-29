let dapp = null
let contract_addresses = {}

function array_from_storage(name) { const x = localStorage.getItem(name); return x == null ? [] : JSON.parse(x) }

let pinned_call_books = {}
let pinned_call_addresses = array_from_storage('pinned_call_addresses')
let pinned_put_books = {}
let pinned_put_addresses = array_from_storage('pinned_put_addresses')

let pinned_buy_orders = {}
let pinned_buy_id = array_from_storage('pinned_buy_id')
let pinned_sell_orders = {}
let pinned_sell_id = array_from_storage('pinned_sell_id')


const SECONDS_IN_AN_HOUR = 60*60
const SECONDS_IN_AN_DAY = 24*SECONDS_IN_AN_HOUR
const PRICE_ADJUSTMENT = 2**16
const BOOK_OPENING_FEE = ethers.utils.parseUnits("1", 'finney')


Date.prototype.toLabel = function() {
	pad0 = (x) => { return (x>9 ? '' : '0') + x }
	return [this.getUTCFullYear(),
			pad0(this.getUTCMonth() + 1),
			pad0(this.getUTCDate())
		].join('-')
		+ ["&nbsp;",
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
function display_price(p) { return parseFloat(p.toNumber()/PRICE_ADJUSTMENT).toFixed(3) }
function nominal_value(q, p) { return p.mul(q).div(PRICE_ADJUSTMENT) }

function book_class(expiry) {
	const time = now()

	if ( expiry <= time ) {
		return 'expired-book'
	} else if ( expiry - time < SECONDS_IN_AN_HOUR ) {
		return 'expiring-book'
	}

	return 'active-book'
}

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

function dapp_is_on() { return dapp !== null }

async function restore_pinned_books(addresses, pinned, contract) {
	await addresses.asyncForEach(async (book_address) => {
		const book_data = await contract._book_data(book_address)
		const expiry = book_data.expiry.toNumber()
		const strike = book_data.strike_per_nominal_unit.toString()

		if ( !(expiry in pinned) ) {
			pinned[expiry] = {}
		}

		pinned[expiry][strike] = new ethers.Contract(book_address, dapp.book_abi, dapp.provider)
		console.log("Restored:", book_address)
	})
}

async function restore_pinned_orders(addresses, pinned, contract) {
	await addresses.asyncForEach(async (book_address) => {
		const book_data = await contract._book_data(book_address)
		const expiry = book_data.expiry.toNumber()
		const strike = book_data.strike_per_nominal_unit.toString()

		if ( !(expiry in pinned) ) {
			pinned[expiry] = {}
		}

		pinned[expiry][strike] = new ethers.Contract(book_address, dapp.book_abi, dapp.provider)
		console.log("Restored:", book_address)
	})
}

async function restore_pinned_call_books() {
	await restore_pinned_books(pinned_call_addresses, pinned_call_books, dapp.call_contract)
}

async function restore_pinned_put_books() {
	await restore_pinned_books(pinned_put_addresses, pinned_put_books, dapp.put_contract)
}

async function initialize_connection(address, provider) {
	const [network, contracts] = await Promise.all([provider.getNetwork(), loadJSON('contract_addresses.json')])
	contract_addresses = contracts

	if ( network.name in contract_addresses ) {
		address = address.toLowerCase()
		const addresses =  contract_addresses[network.name]
		const call_abi = await loadJSON("call_abi.json")
		const put_abi = await loadJSON("put_abi.json")
		const book_abi = await loadJSON("book_abi.json")
		const erc20_abi = await loadJSON("erc20_abi.json")
		const call_contract = new ethers.Contract(addresses.call, call_abi, provider.getSigner())
		const put_contract = new ethers.Contract(addresses.put, put_abi, provider.getSigner())
		const erc20_contract = new ethers.Contract(addresses.erc20, erc20_abi, provider.getSigner())
		dapp = { address, provider, call_contract, put_contract, erc20_contract, book_abi }
		await Promise.all([restore_pinned_call_books(), restore_pinned_put_books()])
		console.log("Dapp is ready on network " + network.name)
	} else {
		show_error("Not available on network " + network.name)
	}
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

/*function remove_element(id)
{
	const element = document.getElementById(id);
	const parent = element.parentNode
	parent.removeChild(element);
	return parent
}*/

function remove_all_children(id) {
	const node = document.getElementById(id);
	while ( node.firstChild ) {
		node.removeChild(node.firstChild);
	}
	return node
}

function book_label(strike, expiry_in_seconds) {
	const expiry_date = new Date(expiry_in_seconds*1000)
	return [display_price(ethers.utils.bigNumberify(strike)), "&mdash;&nbsp;", expiry_date.toLabel()].join('&nbsp;')
}

function order_form(node_id, min_qty, price_tick) {
	return [
			"<select id='", node_id, "-way'><option value='B'>Buy</option><option value='S'>Sell</option></select>",
			"<input id='", node_id, "-qty' type='number' step='0.0001' min='", min_qty, "'>",
			"@<input id='", node_id, "-px' type='number' step='", price_tick, "' min='", price_tick, "'><br>"
		].join('')
}

async function place_order(market_contract, book_address, book_node_id, strike) {
	hide(book_node_id + '-order-form')
	// show(book_node_id + '-wait')

	let quantity = html_value(book_node_id + '-qty')
	let price = html_value(book_node_id + '-px')
	const way = html_value(book_node_id + '-way')

	console.log("Placing order", way, quantity, "ETH @", price, "DAI/ETH")

	quantity = ethers.utils.parseEther( quantity )
	price = adjust_price( price )

	console.log("\t ( Wired order", way, quantity.toString(), "wei @", price.toString(), "adjusted price )")

	try {
		if ( way === 'B') {
			const allow_tx = await dapp.erc20_contract.approve(market_contract.address, nominal_value(quantity, price))
			await allow_tx.wait()
			await market_contract.buy(book_address, quantity, price)
		} else if ( way === 'S') {
			if ( market_contract === dapp.call_contract ) {
				await market_contract.sell(book_address, price, {value: quantity})
			} else if ( market_contract === dapp.put_contract ) {
				const allow_tx = await dapp.erc20_contract.approve(market_contract.address, nominal_value(quantity, strike))
				await allow_tx.wait()
				await market_contract.buy(book_address, quantity, price)
			}
		} else {
			show_error("Unknown order way")
		}
	} catch( err ) {
		show_error("Cannot place order", err)
	}

	// dapp.erc20_contract.approve(market_contract.address, 0)

	show(book_node_id + '-order-form')
	// hide(book_node_id + '-wait')
}

function book_side_node(side, title) {
	const node = document.createElement('div')
	node.className = side
	const title_node = document.createElement('h5')
	title_node.appendChild(document.createTextNode(title))
	node.appendChild(title_node)
	return node
}

async function book_to_html(expiry, strike, book_contract, market_contract) {
	const depth = parseInt(html_value('order-depth'))
	const book_node = document.createElement('div')
	book_node.id = 'B' + book_contract.address
	book_node.className = 'book'
	const title_node = document.createElement('h5')
	title_node.innerHTML = book_label(strike, expiry)
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

		for ( var i = bid_size-1; i >= 0; --i ) {
			bid_entries.push(book_contract.bid_entries(i))
		}

		for ( var i = ask_size-1; i >= 0; --i ) {
			ask_entries.push(book_contract.ask_entries(i))
		}

		bid_entries = await Promise.all(bid_entries)
		ask_entries = await Promise.all(ask_entries)

		bid_entries.asyncForEach( async (e, index) => {
			const entry_node = document.createElement('div')
			bid_node.appendChild(entry_node)

			for ( var i = 0; i < e.size; ++i ) {
				const order_node = document.createElement('div')
				entry_node.appendChild(order_node)
				book_contract.bid_order(index, i).then( (order_id) => {
					book_contract.get_order(order_id).then( (order) => {
						if ( order.alive && order.time + lifetime ) {
							order_node.innerHTML = [
								ethers.utils.formatEther(order.quantity),
								display_price(order.price)
							].join('&nbsp;')
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
				entry_node.appendChild(order_node)
				book_contract.ask_order(index, i).then( (order_id) => {
					book_contract.get_order(order_id).then( (order) => {
						if ( order.alive && order.time + lifetime ) {
							order_node.innerHTML = [
								display_price(order.price),
								ethers.utils.formatEther(order.quantity)
							].join('&nbsp;')
						}
					})
				})
			}
		})

		book_node.appendChild(bid_node)
		book_node.appendChild(ask_node)

		let [minimum_order_quantity, price_tick_size] = await Promise.all([
			book_contract._minimum_order_quantity(),
			book_contract._price_tick_size()
			])
		minimum_order_quantity = ethers.utils.formatEther(minimum_order_quantity)
		price_tick_size = display_price(price_tick_size)

		const order_node = document.createElement('div')
		order_node.id = book_node.id + '-order-form'
		order_node.className = 'order-form'
		order_node.innerHTML = order_form(book_node.id, minimum_order_quantity, price_tick_size)
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
	}

	return book_node
}

async function display_pinned_books(node, pinned, contract) {
	for ( var expiry in pinned ) {
		const tmp = pinned[expiry]
		for ( var strike in tmp ) {
			node.appendChild(await book_to_html(expiry, strike, tmp[strike], contract))
		}
	}
}

async function refresh_pinned_call_books() {
	await display_pinned_books( remove_all_children('call-books-pinned'), pinned_call_books, dapp.call_contract )
}

async function refresh_pinned_put_books() {
	await display_pinned_books( remove_all_children('put-books-pinned'), pinned_put_books, dapp.put_contract )
}

async function add_book_to_pinned(pinned, contract, expiry, strike) {
	if ( !(expiry in pinned) ) {
		pinned[expiry] = {}
	} else if (strike in pinned[expiry]) {
		return null
	}

	const book_address = await contract.get_book_address(expiry, strike)
	const book_contract = new ethers.Contract(book_address, dapp.book_abi, dapp.provider)

	book_contract.on("BuyOrder", (id, event) => {
		add_buy_pinned_order(id)
	})
	book_contract.on("SellOrder", (id, event) => {
		add_sell_pinned_order(id)
	})
	book_contract.on("Expired", (id, event) => {
		refresh_pinned_order(id)
	})
	book_contract.on("Cancelled", (id, event) => {
		refresh_pinned_order(id)
	})

	pinned[expiry][strike] = book_contract
	return book_address
}

async function pin_book(contract, expiry, strike) {
	if ( contract === dapp.call_contract ) {
		const address = await add_book_to_pinned(pinned_call_books, contract, expiry, strike)
		if ( address != null ) {
			refresh_pinned_call_books()
			pinned_call_addresses.push(address)
			localStorage.setItem('pinned_call_addresses', JSON.stringify(pinned_call_addresses))
		}
	} else if ( contract === dapp.put_contract ) {
		const address = await add_book_to_pinned(pinned_put_books, contract, expiry, strike)
		if ( address != null ) {
			refresh_pinned_put_books()
			pinned_put_addresses.push(address)
			localStorage.setItem('pinned_put_addresses', JSON.stringify(pinned_put_addresses))
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
		const strike_str = book_data.strike_per_nominal_unit.toString()
		const book_node = document.createElement('p')
		book_node.innerHTML = book_label(strike_str, expiry_in_seconds)
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
			refresh_pinned_call_books()
		})
		dapp.put_contract.on("BookOpened", (book_address, expiry, strike, event) => {
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
		const tick = adjust_price( html_value('openbook-tick') )
		const orderlife = html_value('openbook-orderlife') * SECONDS_IN_AN_HOUR

		console.assert(expiry - now() >= SECONDS_IN_AN_DAY)
		console.assert(orderlife >= SECONDS_IN_AN_DAY)

		console.log("Opening book: ", expiry, strike.toString(), minqty.toString(), tick.toString(), orderlife)

		const tx = await contract.open_book(expiry, strike, minqty, tick, orderlife, {value: BOOK_OPENING_FEE})
		await tx.wait()
	} catch( err ) {
		show_error("Open book transaction error", err)
	}

	show('openbook-form')
	hide('openbook-wait')
}