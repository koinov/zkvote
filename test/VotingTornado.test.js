/* global artifacts, web3, contract */
require('chai')
  .use(require('bn-chai')(web3.utils.BN))
  .use(require('chai-as-promised'))
  .should()
const fs = require('fs')

const { toBN, randomHex } = require('web3-utils')
const { takeSnapshot, revertSnapshot } = require('../lib/ganacheHelper')

const Tornado = artifacts.require('./VotingTornado.sol')
const Voting = artifacts.require('./Voting.sol')

const { ETH_AMOUNT, MERKLE_TREE_HEIGHT } = process.env

const websnarkUtils = require('websnark/src/utils')
const buildGroth16 = require('websnark/src/groth16')
const stringifyBigInts = require('websnark/tools/stringifybigint').stringifyBigInts
const unstringifyBigInts2 = require('snarkjs/src/stringifybigint').unstringifyBigInts
const snarkjs = require('snarkjs')
const bigInt = snarkjs.bigInt
const crypto = require('crypto')
const circomlib = require('circomlib')
const MerkleTree = require('../lib/MerkleTree')

const rbigint = (nbytes) => snarkjs.bigInt.leBuff2int(crypto.randomBytes(nbytes))
const pedersenHash = (data) => circomlib.babyJub.unpackPoint(circomlib.pedersenHash.hash(data))[0]
const toFixedHex = (number, length = 32) =>  '0x' + bigInt(number).toString(16).padStart(length * 2, '0')
const getVotingId = (votingId) => snarkjs.bigInt.leBuff2int( toBN(votingId).toBuffer() )

function generateDeposit(votingId) {
    let deposit = {
      secret: rbigint(31),
      nullifier: rbigint(31),
      recipient: votingId,
    }
    const preimage = Buffer.concat([deposit.nullifier.leInt2Buff(31), deposit.secret.leInt2Buff(31), deposit.recipient.leInt2Buff(31)])
    deposit.commitment = pedersenHash(preimage)
    return deposit
  }

function snarkVerify(proof) {
    proof = unstringifyBigInts2(proof)
    const verification_key = unstringifyBigInts2(require('../build/circuits/withdraw_verification_key.json'))
    return snarkjs['groth'].isValid(verification_key, proof, proof.publicSignals)
  }


  contract('VotingTornado', accounts => {
    let tornado
    let voting
    const sender = accounts[0]
    const operator = accounts[0]
    const levels = MERKLE_TREE_HEIGHT || 16
    const value = ETH_AMOUNT || '1000000000000000000' // 1 ether
    let snapshotId
    let prefix = 'test'
    let tree
    const fee = bigInt(0)
    const refund = bigInt(0)
    const recipient = getVotingId(1)
    const badRecipient = getVotingId(2)
    const relayer = bigInt(0)
    let groth16
    let circuit
    let proving_key
  
    before(async () => {
      tree = new MerkleTree(
        levels,
        null,
        prefix,
      )
      tornado = await Tornado.deployed()
      voting = await Voting.deployed()
      await voting.methods
      await voting.setTornado(tornado.address, { from: sender})
      await voting.createVoting(2, 1, { from: sender})
      await voting.addVotes(1, accounts[2], 10, { from: sender})
      await voting.addVotes(1, accounts[3], 5, { from: sender})


      snapshotId = await takeSnapshot()
      groth16 = await buildGroth16()
      circuit = require('../build/circuits/withdraw.json')
      proving_key = fs.readFileSync('build/circuits/withdraw_proving_key.bin').buffer
    })

    describe('snark proof verification on js side', () => {
        it('should detect tampering', async () => {
          const deposit = generateDeposit(recipient)
          await tree.insert(deposit.commitment)
          const { root, path_elements, path_index } = await tree.path(0)
    
          const input = stringifyBigInts({
            root,
            nullifierHash: pedersenHash(deposit.nullifier.leInt2Buff(31)),
            nullifier: deposit.nullifier,
            relayer: operator,
            recipient,
            fee,
            refund,
            secret: deposit.secret,
            pathElements: path_elements,
            pathIndices: path_index,
          })
    
          let proofData = await websnarkUtils.genWitnessAndProve(groth16, input, circuit, proving_key)
          const originalProof = JSON.parse(JSON.stringify(proofData))
          let result = snarkVerify(proofData)
          result.should.be.equal(true)
    
          // nullifier
          proofData.publicSignals[1] = '133792158246920651341275668520530514036799294649489851421007411546007850802'
          result = snarkVerify(proofData)
          result.should.be.equal(false)
          proofData = originalProof
    
          // try to cheat with recipient
          proofData.publicSignals[2] = '133738360804642228759657445999390850076318544422'
          result = snarkVerify(proofData)
          result.should.be.equal(false)
          proofData = originalProof
    
          // fee
          proofData.publicSignals[3] = '1337100000000000000000'
          result = snarkVerify(proofData)
          result.should.be.equal(false)
          proofData = originalProof
        })
      })


  describe('#get ballot', () => {
    it('should emit event', async () => {
      let commitment = toFixedHex(42)
      let { logs } = await tornado.getBallot(commitment, 1, { from: accounts[2] })

      logs[0].event.should.be.equal('Ballot')
      logs[0].args.commitment.should.be.equal(commitment)
      logs[0].args.leafIndex.should.be.eq.BN(0)

      commitment = toFixedHex(12);
      ({ logs } = await tornado.getBallot(commitment, 1, { from: accounts[3] }))

      logs[0].event.should.be.equal('Ballot')
      logs[0].args.commitment.should.be.equal(commitment)
      logs[0].args.leafIndex.should.be.eq.BN(1)
    })

    it('should throw if there is a such commitment', async () => {
        const commitment = toFixedHex(42)
        await tornado.getBallot(commitment, 1, {from: accounts[2] }).should.be.fulfilled
        const error = await tornado.getBallot(commitment, 1, { from: accounts[2] }).should.be.rejected
        error.reason.should.be.equal('The commitment has been submitted')
      })
  
  });

  describe('#vote', () => {
    it('should work', async () => {
      const deposit = generateDeposit( getVotingId(1))
      const user = accounts[2]
      await tree.insert(deposit.commitment)
      
      await tornado.getBallot(toFixedHex(deposit.commitment), 1, { from: user })


      const { root, path_elements, path_index } = await tree.path(0)

      const input = stringifyBigInts({
        // public
        root,
        nullifierHash: pedersenHash(deposit.nullifier.leInt2Buff(31)),
        relayer,
        recipient: recipient,
        fee,
        refund,

        // private
        nullifier: deposit.nullifier,
        secret: deposit.secret,
        pathElements: path_elements,
        pathIndices: path_index,
      })


      const proofData = await websnarkUtils.genWitnessAndProve(groth16, input, circuit, proving_key)
      const { proof } = websnarkUtils.toSolidityInput(proofData)


      let isSpent = await tornado.isSpent(toFixedHex(input.nullifierHash))
      isSpent.should.be.equal(false)

      const args = [
        toFixedHex(input.root),
        toFixedHex(input.nullifierHash),
        toFixedHex(input.recipient, 20),
      ]
      const { logs } = await tornado.vote(proof, ...args, 1, { from: accounts[4] })

      logs[0].event.should.be.equal('Vote')
      logs[0].args.nullifierHash.should.be.equal(toFixedHex(input.nullifierHash))
      isSpent = await tornado.isSpent(toFixedHex(input.nullifierHash))
      isSpent.should.be.equal(true)
    }) 
  })

  afterEach(async () => {
        await revertSnapshot(snapshotId.result)
        // eslint-disable-next-line require-atomic-updates
        snapshotId = await takeSnapshot()
        tree = new MerkleTree(
          levels,
          null,
          prefix,
        )
    });

})