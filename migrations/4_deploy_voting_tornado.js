/* global artifacts */
require('dotenv').config({ path: '../.env' })
const VotingTornado = artifacts.require('VotingTornado')
const Verifier = artifacts.require('Verifier')
const hasherContract = artifacts.require('Hasher')
const Voting = artifacts.require('Voting')


module.exports = function(deployer, network, accounts) {
  return deployer.then(async () => {
    const { MERKLE_TREE_HEIGHT, TOKEN_AMOUNT } = process.env
    const verifier = await Verifier.deployed()
    const hasherInstance = await hasherContract.deployed()
    await VotingTornado.link(hasherContract, hasherInstance.address)
    const votingInstance = await deployer.deploy(Voting)
    const tornado = await deployer.deploy(
      VotingTornado,
      verifier.address,
      MERKLE_TREE_HEIGHT,
      accounts[0],
      votingInstance.address,
    )
    console.log('VotingTornado\'s address ', tornado.address)
  })
}
