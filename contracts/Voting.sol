pragma solidity 0.5.17;

import "./Tornado.sol";
import "./IVoting.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";


contract Voting is IVoting {
    using SafeMath for uint256;
    struct VotingEntry {
        address creator ;
        uint256 optionsNumber;
        uint256 nomination;
        uint256 totalVotes;
        mapping (address=>uint256) initialVotes;
        mapping (uint256=>uint256) results;
    }

    address _owner;
    address _tornado;
    mapping (uint256=>VotingEntry) public votings;
    uint256 public votingsCounter;

    constructor() public{
        _owner = msg.sender;
        votingsCounter = 1;
    }

    function nomination(uint256 votingId) public view returns (uint256) {
        return votings[votingId].nomination;
    }


    function setTornado(address addr) public returns (bool) {
        _tornado = addr;
        return true;
    }

    function createVoting(uint256 _optionsNumber, uint256 _nominationValue) public returns (uint256) {
        require(_optionsNumber > 0, "Incorrect number of results");
        require(_nominationValue > 0, "Incorrect nomination value");
        votings[votingsCounter] = VotingEntry(msg.sender, _optionsNumber, _nominationValue, 0);
        votingsCounter += 1;
        return votingsCounter - 1;
    }

    function addVotes(uint256 votingId, address participant, uint256 votes) public returns (bool) {
        require(msg.sender == votings[votingId].creator, "Not a voting creator");
        votings[votingId].initialVotes[participant] = votings[votingId].initialVotes[participant].add(votes);
        votings[votingId].totalVotes = votes.add(votes);
        return true;
    }

    function removeVotes(uint256 votingId, address participant, uint256 votes) public returns (bool) {
        require(msg.sender == votings[votingId].creator, "Not a voting creator");
        votings[votingId].initialVotes[participant] = votings[votingId].initialVotes[participant].sub(votes);
        votings[votingId].totalVotes = votes.sub(votes);
        return true;
    }

    function getBallot(uint256 votingId, address participant) public returns (bool) {
        require(msg.sender == _tornado, "Not Tornado");
        require(votings[votingId].nomination > 0, "Voting is not initialized");
        votings[votingId].initialVotes[participant] = votings[votingId].initialVotes[participant].sub(votings[votingId].nomination);
        return true;
    }

    function vote(uint256 votingId, uint256 option) public returns (bool) {
        require(msg.sender == _tornado, "Not Tornado");
        require(option < votings[votingId].optionsNumber, "Incorrect variant");
        votings[votingId].results[option] = votings[votingId].results[option].add(votings[votingId].nomination);
        return true;
    }

    function getResult(uint256 votingId, uint256 option) public view returns (uint256) {
        return votings[votingId].results[option];
    }

    function getVotes(uint256 votingId, address participant) public view returns (uint256) {
        return votings[votingId].initialVotes[participant];
    }


}