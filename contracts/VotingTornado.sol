// based On https://tornado.cash
/*
* d888888P                                           dP              a88888b.                   dP
*    88                                              88             d8'   `88                   88
*    88    .d8888b. 88d888b. 88d888b. .d8888b. .d888b88 .d8888b.    88        .d8888b. .d8888b. 88d888b.
*    88    88'  `88 88'  `88 88'  `88 88'  `88 88'  `88 88'  `88    88        88'  `88 Y8ooooo. 88'  `88
*    88    88.  .88 88       88    88 88.  .88 88.  .88 88.  .88 dP Y8.   .88 88.  .88       88 88    88
*    dP    `88888P' dP       dP    dP `88888P8 `88888P8 `88888P' 88  Y88888P' `88888P8 `88888P' dP    dP
* ooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooo
*/

pragma solidity 0.5.17;

import "./TornadoVote.sol";
import "./IVoting.sol";

contract VotingTornado is TornadoVote {
  address votingContract;
  constructor(
    IVerifier _verifier,
    uint32 _merkleTreeHeight,
    address _operator,
    address _votingContract
  ) TornadoVote(_verifier, _merkleTreeHeight, _operator) public {
        votingContract = _votingContract;
  }

  function _processGetBallot(uint256 votingId) internal {
    IVoting(votingContract).getBallot(votingId, msg.sender);
  }

  function _processVote(uint256 votingId, uint256 result) internal {
    IVoting(votingContract).vote(votingId, result);
  }
}
