#!/usr/bin/env node
// Temporary demo client
// Works both in browser and node.js

require('dotenv').config()
const fs = require('fs')
const axios = require('axios')
const assert = require('assert')
const snarkjs = require('snarkjs')
const crypto = require('crypto')
const circomlib = require('circomlib')
const bigInt = snarkjs.bigInt
const merkleTree = require('./lib/MerkleTree')
const Web3 = require('web3')
const buildGroth16 = require('websnark/src/groth16')
const websnarkUtils = require('websnark/src/utils')
const { toWei, fromWei, toBN, BN } = require('web3-utils')
const config = require('./config')
const program = require('commander')

let web3, tornado, circuit, proving_key, groth16, erc20, senderAccount, ownerAccount, netId
let MERKLE_TREE_HEIGHT, ETH_AMOUNT, TOKEN_AMOUNT, PRIVATE_KEY

/** Whether we are in a browser or node.js */
const inBrowser = (typeof window !== 'undefined')
let isLocalRPC = false

/** Generate random number of specified byte length */
const rbigint = nbytes => snarkjs.bigInt.leBuff2int(crypto.randomBytes(nbytes))
const getVotingId = (votingId) => snarkjs.bigInt.leBuff2int( toBN(votingId).toBuffer() )

/** Compute pedersen hash */
const pedersenHash = data => circomlib.babyJub.unpackPoint(circomlib.pedersenHash.hash(data))[0]

/** BigNumber to hex string of specified length */
function toHex(number, length = 32) {
  const str = number instanceof Buffer ? number.toString('hex') : bigInt(number).toString(16)
  return '0x' + str.padStart(length * 2, '0')
}

/** Display ETH account balance */
async function printETHBalance({ address, name }) {
  console.log(`${name} ETH balance is`, web3.utils.fromWei(await web3.eth.getBalance(address)))
}

/** Display ERC20 account balance */
async function printERC20Balance({ address, name, tokenAddress }) {
  const erc20ContractJson = require('./build/contracts/ERC20Mock.json')
  erc20 = tokenAddress ? new web3.eth.Contract(erc20ContractJson.abi, tokenAddress) : erc20
  console.log(`${name} Token Balance is`, web3.utils.fromWei(await erc20.methods.balanceOf(address).call()))
}

/**
 * Display accounts information
 */
async function getAccounts() {
  const accounts = await web3.eth.getAccounts()
  for(let a in accounts){
    console.log(`Account #${a} Address ${accounts[a]}`);
  }
}


/**
 * Create deposit object from secret and nullifier
 */
function createDeposit({ nullifier, secret, votingId }) {
  const deposit = { nullifier, secret, votingId }
  deposit.preimage = Buffer.concat([deposit.nullifier.leInt2Buff(31), deposit.secret.leInt2Buff(31), deposit.votingId.leInt2Buff(31)])
  deposit.commitment = pedersenHash(deposit.preimage)
  deposit.commitmentHex = toHex(deposit.commitment)
  deposit.nullifierHash = pedersenHash(deposit.nullifier.leInt2Buff(31))
  deposit.nullifierHex = toHex(deposit.nullifierHash)
  return deposit
}

/**
 * Connect Tornado to voting contract
 */
async function setTornado() {
  console.log(`Setting Tornado address ${tornado.options.address} to voting contract ${voting.options.address}`)
  await voting.methods.setTornado(tornado.options.address).send({ from: senderAccount, gas: 2e6 })
}

/**
 * Create voting
 */
async function createVoting(optionsNumber, nominationValue ) {
  votingId = await voting.methods.votingsCounter().call()
  await voting.methods.createVoting(optionsNumber, nominationValue).send({ from: senderAccount, gas: 2e6 })
  return votingId
}

/**
 * Add votes
 */
async function addVotes(votingId, address, votes ) {
  await voting.methods.addVotes(votingId, address, votes).send({ from: senderAccount, gas: 2e6 })
}

async function getVotes(votingId, address, votes ) {
  return await voting.methods.getVotes(votingId, address).call()
}


/**
 * Connect Tornado to voting contract
 */
async function getVotingInfo(votingId) {
  console.log("Getting voting info. ID : ", votingId)
  const votingEntry = await voting.methods.votings(votingId).call()
  console.log('\n=============Voting=================')
  console.log('Creator               :', votingEntry.creator)
  console.log('Number of options     :', votingEntry.optionsNumber)
  console.log('Nomination            :', votingEntry.nomination)
  console.log('Total votes           :', votingEntry.totalVotes)
  console.log('=============Options================')
  for( let i = 0 ; i < votingEntry.optionsNumber; i ++ ){
    let r = await voting.methods.getResult(votingId, i).call()
    console.log(`Option ${i} votes        :`, r)
  }
  console.log('====================================')

}



/**
 * Make a deposit
 * @param currency Сurrency
 * @param amount Deposit amount
 */
async function getBallot({ votingId, address }) {
  const deposit = createDeposit({ nullifier: rbigint(31), secret: rbigint(31), votingId: getVotingId(votingId) })
  const note = toHex(deposit.preimage, 93)
  const noteString = `tornado-${votingId}-${netId}-${note}`
  console.log(`Your ballot: ${noteString}`)
  console.log('Submitting deposit transaction')
  await tornado.methods.getBallot(toHex(deposit.commitment), votingId).send({ from: address ? address : senderAccount, gas: 2e6 })      .on('transactionHash', function (txHash) {
    if (netId === 1 || netId === 42) {
      console.log(`View transaction on etherscan https://${getCurrentNetworkName()}etherscan.io/tx/${txHash}`)
    } else {
      console.log(`The transaction hash is ${txHash}`)
      web3.eth.getTransactionReceipt(txHash).then((receipt)=>{
        console.log(`The transaction receipt is ${JSON.stringify(receipt)}`)
      });

    }
  }).on('error', function (e) {
    console.error('on transactionHash error', e.message)
  })

  
  return noteString
}

/**
 * Generate merkle tree for a deposit.
 * Download deposit events from the tornado, reconstructs merkle tree, finds our deposit leaf
 * in it and generates merkle proof
 * @param deposit Deposit object
 */
async function generateMerkleProof(deposit) {
  // Get all deposit events from smart contract and assemble merkle tree from them
  console.log('Getting current state from tornado contract')
  const events = await tornado.getPastEvents('Ballot', { fromBlock: 0, toBlock: 'latest' })
  
  const leaves = events
    .sort((a, b) => a.returnValues.leafIndex - b.returnValues.leafIndex) // Sort events in chronological order
    .map(e => e.returnValues.commitment)
  const tree = new merkleTree(MERKLE_TREE_HEIGHT, leaves)

  // Find current commitment in the tree
  const depositEvent = events.find(e => e.returnValues.commitment === toHex(deposit.commitment))
  const leafIndex = depositEvent ? depositEvent.returnValues.leafIndex : -1

  // Validate that our data is correct
  const root = await tree.root()
  const isValidRoot = await tornado.methods.isKnownRoot(toHex(root)).call()
  const isSpent = await tornado.methods.isSpent(toHex(deposit.nullifierHash)).call()
  assert(isValidRoot === true, 'Merkle tree is corrupted')
  assert(isSpent === false, 'The note is already spent')
  assert(leafIndex >= 0, 'The deposit is not found in the tree')

  // Compute merkle proof of our commitment
  return tree.path(leafIndex)
}

/**
 * Generate SNARK proof for withdrawal
 * @param deposit Deposit object
 * @param recipient Funds recipient
 * @param relayer Relayer address
 * @param fee Relayer fee
 * @param refund Receive ether for exchanged tokens
 */
async function generateProof({ deposit, votingId, relayerAddress = 0, fee = 0, refund = 0 }) {
  // Compute merkle proof of our commitment
  const { root, path_elements, path_index } = await generateMerkleProof(deposit)

  // Prepare circuit input
  const input = {
    // Public snark inputs
    root: root,
    nullifierHash: deposit.nullifierHash,
    recipient: bigInt(votingId),
    relayer: bigInt(relayerAddress),
    fee: bigInt(fee),
    refund: bigInt(refund),

    // Private snark inputs
    nullifier: deposit.nullifier,
    secret: deposit.secret,
    pathElements: path_elements,
    pathIndices: path_index,
  }

  console.log('Generating SNARK proof')
  console.time('Proof time')
  const proofData = await websnarkUtils.genWitnessAndProve(groth16, input, circuit, proving_key)
  const { proof } = websnarkUtils.toSolidityInput(proofData)
  console.timeEnd('Proof time')

  const args = [
    toHex(input.root),
    toHex(input.nullifierHash),
    toHex(input.recipient, 31),
  ]

  return { proof, args }
}

/**
 * Do an ETH withdrawal
 * @param noteString Note to withdraw
 * @param recipient Recipient address
 */
async function sendVote({ deposit, votingId, optionNumber, address, relayerURL = null}) {
  if (relayerURL) {
    if (relayerURL.endsWith('.eth')) {
      throw new Error('ENS name resolving is not supported. Please provide DNS name of the relayer. See instuctions in README.md')
    }
    const relayerStatus = await axios.get(relayerURL + '/status')
    const { relayerAddress, netId, gasPrices, ethPrices, relayerServiceFee } = relayerStatus.data
    assert(netId === await web3.eth.net.getId() || netId === '*', 'This relay is for different network')
    console.log('Relay address: ', relayerAddress)

    const decimals = isLocalRPC ? 18 : config.deployments[`netId${netId}`][currency].decimals
    const fee = calculateFee({ gasPrices, currency, amount, refund, ethPrices, relayerServiceFee, decimals })
    if (fee.gt(fromDecimals({ amount, decimals }))) {
      throw new Error('Too high refund')
    }
    const { proof, args } = await generateProof({ deposit, recipient, relayerAddress, fee, refund })

    console.log('Sending withdraw transaction through relay')
    try {
      const relay = await axios.post(relayerURL + '/relay', { contract: tornado._address, proof, args })
      if (netId === 1 || netId === 42) {
        console.log(`Transaction submitted through the relay. View transaction on etherscan https://${getCurrentNetworkName()}etherscan.io/tx/${relay.data.txHash}`)
      } else {
        console.log(`Transaction submitted through the relay. The transaction hash is ${relay.data.txHash}`)
      }

      const receipt = await waitForTxReceipt({ txHash: relay.data.txHash })
      console.log('Transaction mined in block', receipt.blockNumber)
    } catch (e) {
      if (e.response) {
        console.error(e.response.data.error)
      } else {
        console.error(e.message)
      }
    }
  } else { // using private key
    console.log("using private key", votingId)
    const { proof, args } = await generateProof({ deposit, votingId })

    console.log('Submitting withdraw transaction', optionNumber)
    await tornado.methods.vote(proof, ...args, optionNumber).send({ from: address, gas: 1e6 })
      .on('transactionHash', function (txHash) {
        if (netId === 1 || netId === 42) {
          console.log(`View transaction on etherscan https://${getCurrentNetworkName()}etherscan.io/tx/${txHash}`)
        } else {
          console.log(`The transaction hash is ${txHash}`)
        }
      }).on('error', function (e) {
        console.error('on transactionHash error', e.message)
      })
  }
  console.log('Done')
}

function fromDecimals({ amount, decimals }) {
  amount = amount.toString()
  let ether = amount.toString()
  const base = new BN('10').pow(new BN(decimals))
  const baseLength = base.toString(10).length - 1 || 1

  const negative = ether.substring(0, 1) === '-'
  if (negative) {
    ether = ether.substring(1)
  }

  if (ether === '.') {
    throw new Error('[ethjs-unit] while converting number ' + amount + ' to wei, invalid value')
  }

  // Split it into a whole and fractional part
  const comps = ether.split('.')
  if (comps.length > 2) {
    throw new Error(
      '[ethjs-unit] while converting number ' + amount + ' to wei,  too many decimal points'
    )
  }

  let whole = comps[0]
  let fraction = comps[1]

  if (!whole) {
    whole = '0'
  }
  if (!fraction) {
    fraction = '0'
  }
  if (fraction.length > baseLength) {
    throw new Error(
      '[ethjs-unit] while converting number ' + amount + ' to wei, too many decimal places'
    )
  }

  while (fraction.length < baseLength) {
    fraction += '0'
  }

  whole = new BN(whole)
  fraction = new BN(fraction)
  let wei = whole.mul(base).add(fraction)

  if (negative) {
    wei = wei.mul(negative)
  }

  return new BN(wei.toString(10), 10)
}

function toDecimals(value, decimals, fixed) {
  const zero = new BN(0)
  const negative1 = new BN(-1)
  decimals = decimals || 18
  fixed = fixed || 7

  value = new BN(value)
  const negative = value.lt(zero)
  const base = new BN('10').pow(new BN(decimals))
  const baseLength = base.toString(10).length - 1 || 1

  if (negative) {
    value = value.mul(negative1)
  }

  let fraction = value.mod(base).toString(10)
  while (fraction.length < baseLength) {
    fraction = `0${fraction}`
  }
  fraction = fraction.match(/^([0-9]*[1-9]|0)(0*)/)[1]

  const whole = value.div(base).toString(10)
  value = `${whole}${fraction === '0' ? '' : `.${fraction}`}`

  if (negative) {
    value = `-${value}`
  }

  if (fixed) {
    value = value.slice(0, fixed)
  }

  return value
}

function getCurrentNetworkName() {
  switch (netId) {
  case 1:
    return ''
  case 42:
    return 'kovan.'
  }

}

function calculateFee({ gasPrices, currency, amount, refund, ethPrices, relayerServiceFee, decimals }) {
  const decimalsPoint = Math.floor(relayerServiceFee) === Number(relayerServiceFee) ?
    0 :
    relayerServiceFee.toString().split('.')[1].length
  const roundDecimal = 10 ** decimalsPoint
  const total = toBN(fromDecimals({ amount, decimals }))
  const feePercent = total.mul(toBN(relayerServiceFee * roundDecimal)).div(toBN(roundDecimal * 100))
  const expense = toBN(toWei(gasPrices.fast.toString(), 'gwei')).mul(toBN(5e5))
  let desiredFee
  switch (currency) {
  case 'eth': {
    desiredFee = expense.add(feePercent)
    break
  }
  default: {
    desiredFee = expense.add(toBN(refund))
      .mul(toBN(10 ** decimals))
      .div(toBN(ethPrices[currency]))
    desiredFee = desiredFee.add(feePercent)
    break
  }
  }
  return desiredFee
}

/**
 * Waits for transaction to be mined
 * @param txHash Hash of transaction
 * @param attempts
 * @param delay
 */
function waitForTxReceipt({ txHash, attempts = 60, delay = 1000 }) {
  return new Promise((resolve, reject) => {
    const checkForTx = async (txHash, retryAttempt = 0) => {
      const result = await web3.eth.getTransactionReceipt(txHash)
      if (!result || !result.blockNumber) {
        if (retryAttempt <= attempts) {
          setTimeout(() => checkForTx(txHash, retryAttempt + 1), delay)
        } else {
          reject(new Error('tx was not mined'))
        }
      } else {
        resolve(result)
      }
    }
    checkForTx(txHash)
  })
}

/**
 * Parses Tornado.cash note
 * @param noteString the note
 */
function parseNote(noteString) {
  const noteRegex = /tornado-(?<voteId>\d+)-(?<netId>\d+)-0x(?<note>[0-9a-fA-F]{186})/g
  const match = noteRegex.exec(noteString)
  if (!match) {
    throw new Error('The note has invalid format')
  }

  const buf = Buffer.from(match.groups.note, 'hex')
  //console.log("Parsed buf", buf)
  const nullifier = bigInt.leBuff2int(buf.slice(0, 31))
  const secret = bigInt.leBuff2int(buf.slice(31, 62))
  const votingId = bigInt.leBuff2int(buf.slice(62, 93))
  //console.log("Parsed votingId", votingId, buf.slice(62, 93))
  const deposit = createDeposit({ nullifier, secret, votingId })
  const netId = Number(match.groups.netId)

  return { netId, votingId, deposit }
}

async function loadBallotData({ deposit }) {
  try {
    const eventWhenHappened = await tornado.getPastEvents('Ballot', {
      filter: {
        commitment: deposit.commitmentHex
      },
      fromBlock: 0,
      toBlock: 'latest'
    })
    if (eventWhenHappened.length === 0) {
      throw new Error('There is no related deposit, the note is invalid')
    }

    const { timestamp } = eventWhenHappened[0].returnValues
    const txHash = eventWhenHappened[0].transactionHash
    const isSpent = await tornado.methods.isSpent(deposit.nullifierHex).call()
    const receipt = await web3.eth.getTransactionReceipt(txHash)

    return { timestamp, txHash, isSpent, from: receipt.from, commitment: deposit.commitmentHex }
  } catch (e) {
    console.error('loadBallotData', e)
  }
  return {}
}
async function loadVoteData({ deposit }) {
  try {
    const events = await await tornado.getPastEvents('Vote', {
      fromBlock: 0,
      toBlock: 'latest'
    })

    const withdrawEvent = events.filter((event) => {
      return event.returnValues.nullifierHash === deposit.nullifierHex
    })[0]

    if( withdrawEvent == null ) {
      return null
    }
    const receipt = await web3.eth.getTransactionReceipt(withdrawEvent.transactionHash)

    //const fee = withdrawEvent.returnValues.fee
    //const decimals = config.deployments[`netId${netId}`][currency].decimals
    const votingId = withdrawEvent.returnValues.votingId
    const { timestamp } = await web3.eth.getBlock(withdrawEvent.blockHash)
    return {
      votingId : votingId,
      //amount: toDecimals(withdrawalAmount, decimals, 9),
      txHash: withdrawEvent.transactionHash,
      from: receipt.from,
      to: withdrawEvent.returnValues.to,
      timestamp,
      nullifier: deposit.nullifierHex,
    }
  } catch (e) {
    console.error('loadVoteData', e)
  }
}

/**
 * Init web3, contracts, and snark
 */
async function init({ rpc, noteNetId}) {
  let contractJson, votingContractJson, tornadoAddress, votingAddress
    // Initialize from local node
  web3 = new Web3(rpc, null, { transactionConfirmationBlocks: 1 })
  contractJson = require('./build/contracts/VotingTornado.json')
  circuit = require('./build/circuits/withdraw.json')
  proving_key = fs.readFileSync('build/circuits/withdraw_proving_key.bin').buffer
  MERKLE_TREE_HEIGHT = process.env.MERKLE_TREE_HEIGHT || 20
  ETH_AMOUNT = process.env.ETH_AMOUNT
  TOKEN_AMOUNT = process.env.TOKEN_AMOUNT
  OWNER_PRIVATE_KEY = process.env.OWNER_PRIVATE_KEY
  if (OWNER_PRIVATE_KEY) {
    const owner_account = web3.eth.accounts.privateKeyToAccount(OWNER_PRIVATE_KEY)
    web3.eth.accounts.wallet.add(OWNER_PRIVATE_KEY)
    //web3.eth.defaultAccount = owner_account.address
    ownerAccount = owner_account.address
  } 


  PRIVATE_KEY = process.env.PRIVATE_KEY
  if (PRIVATE_KEY) {
    const account = web3.eth.accounts.privateKeyToAccount(PRIVATE_KEY)
    web3.eth.accounts.wallet.add(PRIVATE_KEY)
    web3.eth.defaultAccount = account.address
    senderAccount = account.address
  } else {
    console.log('Warning! PRIVATE_KEY not found. Please provide PRIVATE_KEY in .env file if you deposit')
  }
  votingContractJson = require('./build/contracts/Voting.json')

  // groth16 initialises a lot of Promises that will never be resolved, that's why we need to use process.exit to terminate the CLI
  groth16 = await buildGroth16()
  netId = await web3.eth.net.getId()
  if (noteNetId && Number(noteNetId) !== netId) {
    throw new Error('This note is for a different network. Specify the --rpc option explicitly')
  }
  isLocalRPC = netId > 42

  if (isLocalRPC) {
    tornadoAddress = contractJson.networks[netId].address
    votingAddress = votingContractJson.networks[netId].address
    senderAccount = (await web3.eth.getAccounts())[0]
  } else {
    try {
      tornadoAddress = config.deployments[`netId${netId}`][currency].instanceAddress[amount]
      if (!tornadoAddress) {
        throw new Error()
      }
      tokenAddress = config.deployments[`netId${netId}`][currency].tokenAddress
    } catch (e) {
      console.error('There is no such tornado instance, check the currency and amount you provide')
      process.exit(1)
    }
  }
  tornado = new web3.eth.Contract(contractJson.abi, tornadoAddress)
  voting = new web3.eth.Contract(votingContractJson.abi, votingAddress) 
}

async function getActiveAddress(address) {
  if( address == "new" ) {
    const newAccount = await addNewAccount()
    await topupAccount(ownerAccount, newAccount, web3.utils.toWei("0.1", "ether") );
    return newAccount
  }
  if( address.length > 0 && address.length < 42 ){
    return (await web3.eth.getAccounts())[parseInt(address)]
  }
  if( address.substring(0,2) == "0x"){
    return address
  }
  const account = web3.eth.accounts.privateKeyToAccount(PRIVATE_KEY)
  return account.address
}

async function addNewAccount(){
  const newAccount = await web3.eth.accounts.create()
  web3.eth.accounts.wallet.add(newAccount)
  return newAccount.address;
}

async function topupAccount(from, to, value){
  await web3.eth.sendTransaction({from: from ? from : ownerAccount, to, value, gas : 2e6 })
}

async function main() {

    program
      .option('-r, --rpc <URL>', 'The RPC, CLI should interact with', 'http://localhost:8545')
      .option('-R, --relayer <URL>', 'Withdraw via relayer')
      .option('-A, --address <address>', 'Address in form of # or 0x')
    program
      .command('accounts')
      .description('Display accounts information')
      .action(async () => {
        await init({ rpc: program.rpc})
        await getAccounts()
        console.log("Active address:",await getActiveAddress(program.address || "") )
      })


    program
      .command('createVoting <optionsNumber> <nominationValue>')
      .description('Creates voting')
      .action(async (optionsNumber, nominationValue) => {
        await init({ rpc: program.rpc })
        const votingId = await createVoting(optionsNumber, nominationValue )
        console.log("Voting created. ID : ", votingId )

      })
    program
      .command('addVotes <votingId> <votes>')
      .description('addVotes')
      .action(async (votingId, votes) => {
        await init({ rpc: program.rpc })
        accountAddress = await getActiveAddress(program.address)
        console.log("Using account ", accountAddress)
        await addVotes( votingId, accountAddress, votes)
      })
    program
      .command('getVotes <votingId>')
      .description('getVotes')
      .action(async (votingId, votes) => {
        await init({ rpc: program.rpc })
        accountAddress = await getActiveAddress(program.address)
        console.log("Using account ", accountAddress)
        const votesNumber = await getVotes( votingId, accountAddress)
        console.log("Available votes", votesNumber)
      })

    program
      .command('votingInfo <votingId>')
      .description('Get voting info')
      .action(async (votingId) => {
        await init({ rpc: program.rpc })
        await getVotingInfo(votingId)
      })
    program
      .command('ballot <votingId>')
      .description('Submit a deposit of specified currency and amount from default eth account and return the resulting note. The currency is one of (ETH|DAI|cDAI|USDC|cUSDC|USDT). The amount depends on currency, see config.js file or visit https://tornado.cash.')
      .action(async (votingId) => {
        await init({ rpc: program.rpc })
        accountAddress = await getActiveAddress(program.address)
        await getBallot({ votingId : votingId, address : accountAddress })
      })
    program
      .command('setTornado')
      .description('Sets tornado address')
      .action(async () => {
        await init({ rpc: program.rpc })
        await setTornado()
      })

    program
      .command('vote <note> <option>')
      .description('Withdraw a note to a recipient account using relayer or specified private key. You can exchange some of your deposit`s tokens to ETH during the withdrawal by specifing ETH_purchase (e.g. 0.01) to pay for gas in future transactions. Also see the --relayer option.')
      .action(async (noteString, option) => {
        const { netId, votingId, deposit } = parseNote(noteString)
        await init({ rpc: program.rpc, noteNetId: netId })
        accountAddress = await getActiveAddress(program.address)
        console.log("Using account ", accountAddress)
        await sendVote({ deposit, votingId, optionNumber: option, address : accountAddress  })
      })
    program
      .command('balance <address> [token_address]')
      .description('Check ETH and ERC20 balance')
      .action(async (address, tokenAddress) => {
        await init({ rpc: program.rpc })
        await printETHBalance({ address, name: '' })
        if (tokenAddress) {
          await printERC20Balance({ address, name: '', tokenAddress })
        }
      })
    program
      .command('compliance <note>')
      .description('Shows the deposit and withdrawal of the provided note. This might be necessary to show the origin of assets held in your withdrawal address.')
      .action(async (noteString) => {
        const { currency, amount, netId, deposit } = parseNote(noteString)
        await init({ rpc: program.rpc, noteNetId: netId, currency, amount })
        const depositInfo = await loadBallotData({ deposit })
        const depositDate = new Date(depositInfo.timestamp * 1000)
        console.log('\n=============Ballot==================')
        console.log('Deposit     :', amount, currency)
        console.log('Date        :', depositDate.toLocaleDateString(), depositDate.toLocaleTimeString())
        console.log('From        :', `${getCurrentNetworkName() ? "https://"+getCurrentNetworkName() + "etherscan.io/address/" + depositInfo.from : depositInfo.from}`)
        console.log('Transaction :', `${getCurrentNetworkName() ? "https://"+getCurrentNetworkName() + "etherscan.io/tx/" + depositInfo.txHash : depositInfo.txHash}`)
        console.log('Commitment  :', depositInfo.commitment)
        if (deposit.isSpent) {
          console.log('The note was not spent')
        }

        const withdrawInfo = await loadVoteData({ deposit })
        console.log('\n=============Vote====================')
        if( withdrawInfo != null ){
          const withdrawalDate = new Date(withdrawInfo.timestamp * 1000)
          console.log('VotingId    :', withdrawInfo.votingId)
          console.log('Date        :', withdrawalDate.toLocaleDateString(), withdrawalDate.toLocaleTimeString())
          console.log('From        :', `${getCurrentNetworkName() ? "https://" + getCurrentNetworkName() + "etherscan.io/address/" + withdrawInfo.from : withdrawInfo.from}`)
          console.log('Transaction :', `${getCurrentNetworkName() ? "https://" + getCurrentNetworkName() +  "etherscan.io/tx/"+withdrawInfo.txHash : withdrawInfo.txHash}`)
          console.log('Nullifier   :', withdrawInfo.nullifier)
        } else{
          console.log('Ballot is unspent')

        }
        console.log('\n=====================================')

      })
    program
      .command('test')
      .description('Perform an automated test. It deposits and withdraws one ETH and one ERC20 note. Uses ganache.')
      .action(async () => {
        console.log('Start performing ETH deposit-withdraw test')
        let currency = 'eth'
        let amount = '0.1'
        await init({ rpc: program.rpc, currency, amount })
        let noteString = await deposit({ currency, amount })
        let parsedNote = parseNote(noteString)
        await withdraw({ deposit: parsedNote.deposit, currency, amount, recipient: senderAccount, relayerURL: program.relayer })

        console.log('\nStart performing DAI deposit-withdraw test')
        currency = 'dai'
        amount = '100'
        await init({ rpc: program.rpc, currency, amount })
        noteString = await deposit({ currency, amount })
        ; (parsedNote = parseNote(noteString))
        await withdraw({ deposit: parsedNote.deposit, currency, amount, recipient: senderAccount, refund: '0.02', relayerURL: program.relayer })
      })
    try {
      await program.parseAsync(process.argv)
      process.exit(0)
    } catch (e) {
      console.log('Error:', e)
      process.exit(1)
    }
  
}

main()
