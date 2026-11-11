// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

// A test token for local devnets. Minting and burning are open: anyone can mint any amount to
// anyone, and burn anyone's tokens. Never deploy it anywhere that matters.
contract TestToken {
    string public constant name = "Test Token";
    string public constant symbol = "TEST";
    uint8 public constant decimals = 18;

    mapping(address => uint256) public balanceOf;

    event Transfer(address indexed from, address indexed to, uint256 value);

    function transfer(address to, uint256 value) external returns (bool) {
        balanceOf[msg.sender] -= value; // reverts on underflow
        balanceOf[to] += value;
        emit Transfer(msg.sender, to, value);
        return true;
    }

    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function burn(address from, uint256 value) external {
        balanceOf[from] -= value; // reverts on underflow
        emit Transfer(from, address(0), value);
    }
}
