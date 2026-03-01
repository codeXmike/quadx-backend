const { CONNECT_TARGET, DEFAULT_COLS, DEFAULT_ROWS } = require("./constants");

function createBoard(rows = DEFAULT_ROWS, cols = DEFAULT_COLS) {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => null));
}

function inBounds(board, row, col) {
  return row >= 0 && row < board.length && col >= 0 && col < board[0].length;
}

function dropSeed(board, col, mark) {
  if (!Number.isInteger(col)) {
    throw new Error("Column must be an integer");
  }
  if (col < 0 || col >= board[0].length) {
    throw new Error("Column out of range");
  }

  for (let row = board.length - 1; row >= 0; row -= 1) {
    if (!board[row][col]) {
      board[row][col] = mark;
      return { row, col };
    }
  }

  throw new Error("Column is full");
}

function countDirection(board, row, col, mark, dRow, dCol) {
  let count = 0;
  let r = row + dRow;
  let c = col + dCol;

  while (inBounds(board, r, c) && board[r][c] === mark) {
    count += 1;
    r += dRow;
    c += dCol;
  }
  return count;
}

function hasConnectFour(board, row, col, mark) {
  const axes = [
    { dRow: 0, dCol: 1 },
    { dRow: 1, dCol: 0 },
    { dRow: 1, dCol: 1 },
    { dRow: 1, dCol: -1 }
  ];

  return axes.some(({ dRow, dCol }) => {
    const forward = countDirection(board, row, col, mark, dRow, dCol);
    const backward = countDirection(board, row, col, mark, -dRow, -dCol);
    return 1 + forward + backward >= CONNECT_TARGET;
  });
}

function isBoardFull(board) {
  return board[0].every((cell) => Boolean(cell));
}

module.exports = { createBoard, dropSeed, hasConnectFour, isBoardFull };
