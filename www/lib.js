let dapp = null
let contract_addresses = {}

const SECONDS_IN_AN_HOUR = 60*60
const SECONDS_IN_A_DAY = 24*SECONDS_IN_AN_HOUR
const PRICE_ADJUSTMENT = 2**3
const BOOK_OPENING_FEE = ethers.utils.parseUnits("10", 'finney')
const ADDRESS_ZERO = '0x0000000000000000000000000000000000000000'
const MAX_GAS = 8000000
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
	return Promise.all(promises)
}

Array.prototype.waitForEach = async function (callback) {
	for (let index = 0; index < this.length; index++) {
		await callback(this[index], index, this)
	}
}

function array_from_storage(name) { const x = localStorage.getItem(name); return x == null ? [] : JSON.parse(x) }

function hide(id) {
	document.getElementById(id).style.display = 'none'
}

function show(id) {
	document.getElementById(id).style.display = 'block'
}

function remove_element(id)
{
	const element = document.getElementById(id);
	const parent = element.parentNode
	parent.removeChild(element);
	return parent
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

function now() { return Math.floor(Date.now()/1000) }
function adjust_price(p) { return ethers.utils.bigNumberify(Math.floor(p*PRICE_ADJUSTMENT)) }
function display_price(p, precision = 3) { return parseFloat(p.toNumber()/PRICE_ADJUSTMENT).toFixed(precision) }
function nominal_value(q, p) { return q.mul(p).div(PRICE_ADJUSTMENT) }

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
	return [display_price(ethers.utils.bigNumberify(strike)), "\u2014", expiry_date.toLabel()].join('\u00A0')
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

async function get_position(contract) {
	const [nominal_shares, written_shares] = await Promise.all([
		contract._nominal_shares(dapp.address),
		contract._writers(dapp.address),
		])

	return [nominal_shares, written_shares]
}

async function compute_position(contract) {
	const [nominal_shares, written_shares] = await get_position(contract)
	return nominal_shares.sub(written_shares)
}

function dapp_is_on() { return dapp !== null }


const main_ctrl = ($scope) => {
	$scope.network = "Network unknown"

	$scope.connect_metamask = async() => {
		hide('connection-form')
		show('connection-wait')

		try {
			let [address] = await ethereum.enable()
			const provider = new ethers.providers.Web3Provider(ethereum)
			
			const [network, contracts] = await Promise.all([provider.getNetwork(), loadJSON('contract_addresses.json')])
			contract_addresses = contracts

			if ( network.name in contract_addresses ) {
				address = address.toLowerCase()
				contract_addresses =  contract_addresses[network.name]

				$scope.network = network.name

				const [market_abi, call_book_abi, put_book_abi, erc20_abi] = await Promise.all([
						loadJSON("market_abi.json")
					,	loadJSON("call_book_abi.json")
					,	loadJSON("put_book_abi.json")
					,	loadJSON("erc20_abi.json")
					])

				const call_contract = new ethers.Contract(contract_addresses.call, market_abi, provider.getSigner())
				const put_contract = new ethers.Contract(contract_addresses.put, market_abi, provider.getSigner())
				const erc20_contract = new ethers.Contract(contract_addresses.erc20, erc20_abi, provider.getSigner())

				dapp = {
					address,
					provider,
					call_contract,
					put_contract,
					erc20_contract,
					call_book_abi,
					put_book_abi
				}

				call_contract.on("BookOpened", (book_address, expiry, strike, event) => {
					console.log("Call book opened", book_address, new Date(expiry.mul(1000).toNumber()).toLabel(), display_price(strike))
					$scope.$broadcast("call_book_opened", {book_address, expiry, strike})
				})
				put_contract.on("BookOpened", (book_address, expiry, strike, event) => {
					console.log("Put book opened", book_address, new Date(expiry.mul(1000).toNumber()).toLabel(), display_price(strike))
					$scope.$broadcast("put_book_opened", {book_address, expiry, strike})
				})

				$scope.$broadcast('wallet_initialized', ["metamask", network.name])
				console.log("Dapp is ready")
			} else {
				throw("not available on network " + network.name)
			}
		} catch( err ) {
			dapp = null
			show_error("Wallet connection problem", err)
		}

		show('connection-form')
		hide('connection-wait')
	}
}


const pinned_books_ctrl = ($scope) => {
	$scope.call_books = []
	$scope.put_books = []
	$scope.call_book_contracts = {}
	$scope.put_book_contracts = {}
	$scope.call_book_addresses = array_from_storage('pinned_call_book_addresses')
	$scope.put_book_addresses = array_from_storage('pinned_put_book_addresses')

	$scope.call = async(book) => {
		const quantity = ethers.utils.parseEther( book.apply.quantity.toString() )
		await $scope.approve_if_needed(book.contract.address, nominal_value(quantity, book.strike))

		try {
			const tx = await book.contract.call(quantity, {gasLimit: MAX_GAS})
			await tx.wait()
		} catch( err ) {
			show_error("Cannot apply option", err)
		}

		$scope.compute_position(book)
	}

	$scope.put = async(book) => {
		const quantity = ethers.utils.parseEther( book.apply.quantity.toString() )

		try {
			const tx = await book.contract.put({value: quantity, gasLimit: MAX_GAS})
			await tx.wait()
		} catch( err ) {
			show_error("Cannot apply option", err)
		}

		$scope.compute_position(book)
	}

	$scope.settle = async(book) => {
		try {
			const tx = await book.contract.settle({gasLimit: MAX_GAS})
			await tx.wait()
		} catch( err ) {
			show_error("Cannot settle option", err)
		}

		$scope.compute_position(book)
	}

	$scope.liquidate = async(book) => {
		try {
			const tx = await book.contract.liquidate()
			await tx.wait()
		} catch( err ) {
			show_error("Cannot liquidate option", err)
		}

		$scope.compute_position(book)
	}

	$scope.cancel = async(order) => {
		try {
			const tx = await order.contract.cancel(order.id)
			await tx.wait()
		} catch( err ) {
			show_error("Cannot cancel order", err)
		}
	}

	$scope.approve_if_needed = async(contract_address, needed_amount) => {
		const allowance = await dapp.erc20_contract.allowance(dapp.address, contract_address)

		console.log("\t ( needed:", needed_amount.toString(), ", currently allowed:", allowance.toString(), ")")

		if ( allowance.lt(needed_amount) )
		{
			const tx = await dapp.erc20_contract.approve(contract_address, needed_amount)
			await tx.wait()
		}
	}

	$scope.place_order = async(book) => {
		hide(book.id + '-order-form')
		show(book.id + '-order-wait')

		const way = book.order.way

		console.log("Placing order", way, book.order.quantity, "ETH @", book.order.price, "DAI/ETH")

		const quantity = ethers.utils.parseEther( book.order.quantity.toString() )
		const price = adjust_price( book.order.price )
		const market_contract = book.market_contract

		console.log("\t ( Wired order", way, quantity.toString(), "wei @", price.toString(), "adjusted price )")

		try {
			const contract = book.contract

			if ( way === 'B') {
				await $scope.approve_if_needed(contract.address, nominal_value(quantity, price))
				await contract.buy(quantity, price, {gasLimit: MAX_GAS})
			} else if ( way === 'S') {
				const available = await contract.free_shares(dapp.address)
				const extra_quantity = quantity.sub(available)

				if ( market_contract === dapp.call_contract ) {
					if (extra_quantity.gt(0)) {
						await contract.sell(quantity, price, {value: extra_quantity, gasLimit: MAX_GAS})
					} else {
						await contract.sell(quantity, price, {gasLimit: MAX_GAS})
					}
				} else if ( market_contract === dapp.put_contract ) {
					if (extra_quantity.gt(0)) {
						await $scope.approve_if_needed(contract.address, nominal_value(extra_quantity, book.strike))
					}
					await contract.sell(quantity, price, {gasLimit: MAX_GAS})
				}
			} else {
				show_error("Unknown order way")
			}
		} catch( err ) {
			show_error("Cannot place order", err)
		}

		// dapp.erc20_contract.approve(market_contract.address, 0)

		show(book.id + '-order-form')
		hide(book.id + '-order-wait')
	}

	$scope.retrieve_orders = async (book) => {
		let bid_orders = [], ask_orders = []
		let [bid_size, ask_size] =
			await Promise.all([book.contract.bid_size(), book.contract.ask_size()])
		bid_size = bid_size.toNumber()
		ask_size = ask_size.toNumber()
		let bid_entries = []
		let ask_entries = []

		for ( var i = 0; i < bid_size; ++i ) {
			bid_entries.push(book.contract.bid_entries(i))
		}

		for ( var i = 0; i < ask_size; ++i ) {
			ask_entries.push(book.contract.ask_entries(i))
		}

		[bid_entries, ask_entries] = await Promise.all([Promise.all(bid_entries), Promise.all(ask_entries)])

		await Promise.all([
			bid_entries.waitForEach( async (e, index) => {
				for ( var i = 0; i < e.size; ++i ) {
					const order_id = await book.contract.bid_order(index, i)
					const order = await book.contract._orders(order_id)

					if ( order.alive == 1 ) {
						let order_data = {
							id: order_id,
							contract: book.contract,
							price: display_price(order.price),
							quantity: ethers.utils.formatEther(order.quantity),
							node_id: order_node_id(book.contract.address, order_id)
						}

						if ( order.issuer.toLowerCase() == dapp.address ) {
							order_data.class = 'owned-order'
						} else {
							order.class = ''
						}

						bid_orders.push(order_data)
					}
				}
			})
			,
			ask_entries.waitForEach( async (e, index) => {
				for ( var i = 0; i < e.size; ++i ) {
					const order_id = await book.contract.ask_order(index, i)
					const order = await book.contract._orders(order_id)

					if ( order.alive == 1 ) {
						let order_data = {
							id: order_id,
							contract: book.contract,
							price: display_price(order.price),
							quantity: ethers.utils.formatEther(order.quantity),
							node_id: order_node_id(book.contract.address, order_id)
						}

						if ( order.issuer.toLowerCase() == dapp.address ) {
							order_data.class = 'owned-order'
						} else {
							order_data.class = ''
						}

						ask_orders.push(order_data)
					}
				}
			})
			])

		book.bid = bid_orders.reverse()
		book.ask = ask_orders.reverse()
		$scope.$apply()
	}

	$scope.retrieve_last = async (book) => {
		const nb_exec = await book.contract.nb_executions()

		if (false == nb_exec.isZero()) {
			const last = await book.contract._executions(nb_exec.sub(1))
			book.last = {
				price: display_price(last.price),
				quantity: ethers.utils.formatEther(last.quantity),
				time: new Date(last.time.mul(1000).toNumber()).toLabel()
			}
		}
	}

	$scope.compute_position = async (book) => {
		const [[nominal_shares, written_shares], can_liquidate] = await Promise.all([
			get_position(book.contract), book.contract.can_liquidate() ])
		const position = nominal_shares.sub(written_shares)
		book.can_liquidate = can_liquidate
		book.position = ethers.utils.formatEther(position)

		if (nominal_shares.eq(written_shares)) {
			book.exposition = 0
			book.can_apply = false
			book.can_settle = false
		} else if (nominal_shares.gt(written_shares)) {
			book.exposition = ethers.utils.formatEther(nominal_value(position, book.strike).toString())
			book.can_apply = await book.contract.can_apply()
			book.can_settle = false
		} else {
			book.exposition = ethers.utils.formatEther(nominal_value(written_shares.sub(nominal_shares), book.strike).toString())
			book.can_apply = false
			book.can_settle = await book.contract.can_settle()
		}

		$scope.$apply()	
	}

	$scope.build_book = async (market_contract, book_contract, expiry, strike, label = null, class_name = null) => {
		const quantity_unit = ethers.utils.formatEther(await book_contract._order_quantity_unit())

		label = label === null ? option_label(strike, expiry) : label
		class_name = class_name === null ? book_class(expiry) : class_name

		const book = {
			id: book_node_id(book_contract.address),
			order: {way:'B'},
			apply: {},
			class: class_name,
			bid: [],
			ask: [],
			position: 0,
			expiry,
			strike,
			label,
			quantity_unit,
			contract : book_contract,
			alive: class_name != 'expired-book',
			market_contract
		}

		if(book.alive) {
			book_contract.on("BuyOrder", (id, event) => {
				console.log("Buy order entered", id)
				$scope.retrieve_orders(book)
				$scope.compute_position(book)
			})
			book_contract.on("SellOrder", (id, event) => {
				console.log("Sell order entered", id)
				$scope.retrieve_orders(book)
				$scope.compute_position(book)
			})
			book_contract.on("Cancelled", (id, event) => {
				console.log("Order cancelled", id)
				remove_element(order_node_id(book.contract.address, id))
				$scope.compute_position(book)
			})
			book_contract.on("Hit", (hit_order, buyer, seller, price, quantity, user_data, event) => {
				console.log("Hit", buyer, seller, display_price(price), quantity.toString())
				$scope.retrieve_orders(book)
				$scope.retrieve_last(book)

				if ( buyer.toLowerCase() == dapp.address || seller.toLowerCase() == dapp.address )
				{
					$scope.compute_position(book)
				}
			})

			// don't wait for next two calls to finish
			$scope.retrieve_orders(book)
			$scope.retrieve_last(book)
		}

		$scope.compute_position(book)
		return book
	}

	$scope.restore_pinned_books = async(addresses, contracts, market_contract, option_book_abi) => {
		let result = []

		await addresses.asyncForEach(async (address) => {
			const book_contract = new ethers.Contract(address, option_book_abi, dapp.provider.getSigner())
			const expiry = (await book_contract._expiry()).toNumber()
			const strike = (await book_contract._strike_per_underlying_unit()).toString()

			if ( !(expiry in contracts) ) {
				contracts[expiry] = {}
			}

			const book = await $scope.build_book(market_contract, book_contract, expiry, strike)
			result.push(book)
			contracts[expiry][strike] = book.contract
			console.log("Restored book:", address)
		})

		return result
	}

	$scope.add_book = async (contracts, books, data, option_book_abi) => {
		const expiry = data.expiry
		const strike = data.strike

		if ( !(expiry in contracts) ) {
			contracts[expiry] = {}
		} else if (strike in contracts[expiry]) {
			return null
		}

		const book_contract = new ethers.Contract(data.address, option_book_abi, dapp.provider.getSigner())
		const book = await $scope.build_book(data.market_contract, book_contract, expiry, strike, data.label, data.class)
		books.push(book)
		contracts[expiry][strike] = book.contract
		return book_contract.address
	}

	$scope.initialize = async() => {
		[$scope.call_books, $scope.put_books] = await Promise.all([
			$scope.restore_pinned_books($scope.call_book_addresses, $scope.call_book_contracts, dapp.call_contract, dapp.call_book_abi),
			$scope.restore_pinned_books($scope.put_book_addresses, $scope.put_book_contracts, dapp.put_contract, dapp.put_book_abi)
			])
	}

	$scope.$on('wallet_initialized', (event, args) => {
		$scope.initialize()
	})

	$scope.$on('call_book_pinned', async (event, book) => {
		const address = await $scope.add_book($scope.call_book_contracts, $scope.call_books, book, dapp.call_book_abi)
		if ( address != null ) {
			$scope.call_book_addresses.push(address)
			localStorage.setItem('pinned_call_book_addresses', JSON.stringify($scope.call_book_addresses))
			$scope.$apply()
		}
	})

	$scope.$on('put_book_pinned', async (event, book) => {
		const address = await $scope.add_book($scope.put_book_contracts, $scope.put_books, book, dapp.put_book_abi)
		if ( address != null ) {
			$scope.put_book_addresses.push(address)
			localStorage.setItem('pinned_put_book_addresses', JSON.stringify($scope.put_book_addresses))
			$scope.$apply()
		}
	})
}


const books_ctrl = ($scope, $rootScope) => {
	$scope.call_books = []
	$scope.put_books = []
	$scope.search_depth = 10

	$scope.pin_call = (book) => {
		$rootScope.$broadcast("call_book_pinned", book)
	}

	$scope.pin_put = (book) => {
		$rootScope.$broadcast("put_book_pinned", book)
	}

	$scope.book_info = (market_contract, book_address, expiry, strike) => {
		const class_name = book_class(expiry)

		return {
			expiry,
			strike,
			market_contract,
			address: book_address,
			label: option_label(strike, expiry),
			class: class_name,
			alive: class_name != 'expired-book'
		}
	}

	$scope.get_books = async (contract, option_book_abi, max_depth) => {
		let result = []
		const nb_books = await contract.nb_books()
		const limit = Math.min(max_depth, nb_books)

		for (var i = 1; i <= limit; ++i) {
			const book_address = await contract._book_addresses(nb_books - i)
			const book_contract = new ethers.Contract(book_address, option_book_abi, dapp.provider.getSigner())
			const expiry = (await book_contract._expiry()).toNumber()
			const strike = (await book_contract._strike_per_underlying_unit()).toString()
			const position = await compute_position(book_contract)
			const info = $scope.book_info(contract, book_address, expiry, strike)
			result.push(info)

			if (false == position.isZero()) {
				if(contract == dapp.call_contract) {
					$scope.pin_call(info)
				} else {
					$scope.pin_put(info)
				}
			}
		}

		return result
	}

	$scope.refresh = async() => {
		[$scope.call_books, $scope.put_books] = await Promise.all([
			$scope.get_books(dapp.call_contract, dapp.call_book_abi, $scope.search_depth),
			$scope.get_books(dapp.put_contract, dapp.put_book_abi, $scope.search_depth)
			]);
		$scope.$apply()
	}

	$scope.initialize = () => {
		hide('intro')
		show('header')
		show('books')
		show('pinned-books')
		$scope.refresh()
	}

	$scope.$on('wallet_initialized', (event, args) => {
		console.log("Connected to", args[1], "through", args[0])
		$scope.initialize()
	})

	$scope.$on('call_book_opened', async (event, args) => {
		$scope.call_books.unshift($scope.book_info(dapp.call_contract, args.book_address, args.expiry, args.strike))
		$scope.$apply()
	})

	$scope.$on('put_book_opened', async (event, args) => {
		$scope.put_books.unshift($scope.book_info(dapp.put_contract, args.book_address, args.expiry, args.strike))
		$scope.$apply()
	})
}


const open_book_ctrl = ($scope) => {
	$scope.type = "call"
	$scope.strike = 0.125
	$scope.quantity_unit = 0.0001
	$scope.tomorrow = new Date()
    $scope.tomorrow.setDate($scope.tomorrow.getDate() + 1)

	$scope.open = async() => {
		let market_contract = null

		if ( $scope.type == 'call' ) {
			market_contract = dapp.call_contract
		} else if ( $scope.type == 'put' ) {
			market_contract = dapp.put_contract
		} else {
			show_error("Bad instrument type")
			return
		}

		hide('openbook-form')
		show('openbook-wait')

		try
		{
			// angular model pipeline transforms expiry, we need its raw value, cause we don't know better
			const expiry = Math.floor(new Date(document.getElementById('openbook-expiry').value + "T14:00Z").getTime()/1000)
			const strike = adjust_price( $scope.strike )
			const quantity_unit = ethers.utils.parseEther( $scope.quantity_unit.toString() )

			if(expiry - now() < SECONDS_IN_A_DAY) {
				throw "expiry must be at least 24h away"
			}

			console.log("Opening book: ", expiry, strike.toString(), quantity_unit.toString())

			const tx = await market_contract.open_book(expiry, strike, quantity_unit, {value: BOOK_OPENING_FEE})
			await tx.wait()
		} catch( err ) {
			show_error("Open book transaction error", err)
		}

		show('openbook-form')
		hide('openbook-wait')
	}
}


const app = angular.module('Plethora', [])
app.controller('main_ctrl', main_ctrl)
app.controller('pinned_books_ctrl', pinned_books_ctrl)
app.controller('books_ctrl', ['$scope','$rootScope', books_ctrl])
app.controller('open_book_ctrl', open_book_ctrl)
