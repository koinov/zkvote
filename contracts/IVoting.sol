pragma solidity 0.5.17;

interface IVoting {
    function nomination(uint256 votingId) external view returns (uint256);
    function vote(uint256 votingId, uint256 variant) external returns (bool);
    function getBallot(uint256 votingId, address participant) external returns (bool);
}