import { expect, test } from 'vitest';
import { columnGapX, isColumnWrap, roundedPath, sideLink, turnLink } from '../src/canvas/edges';
import { COLUMN_GAP, TURN_GAP, TURN_GAP_X } from '../src/canvas/layout';

const box = (x: number, y: number, width = 240, height = 50) => ({ x, y, width, height });

test('roundedPath：直线不加圆角；重复点和直线上的中间点被去掉', () => {
  expect(roundedPath([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }])).toBe('M 0 0 L 100 0');
  expect(roundedPath([])).toBe('');
  expect(roundedPath([{ x: 3, y: 4 }])).toBe('M 3 4');
});

test('roundedPath：拐角用圆角，线段太短时圆角缩小到线段的一半', () => {
  expect(roundedPath([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], 10)).toBe('M 0 0 L 90 0 Q 100 0 100 10 L 100 100');
  expect(roundedPath([{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 100 }], 10)).toBe('M 0 0 L 4 0 Q 8 0 8 4 L 8 100');
});

test('isColumnWrap：目标在右边且不在源节点下方才算折列的连线', () => {
  expect(isColumnWrap(box(0, 640), box(312, 0))).toBe(true);
  expect(isColumnWrap(box(0, 0), box(312, 0))).toBe(true); // a one-node column
  expect(isColumnWrap(box(0, 0), box(0, 80))).toBe(false); // the ordinary case: below
  expect(isColumnWrap(box(0, 0), box(264, 80))).toBe(false); // a fork child: below and to the right
});

test('columnGapX：取源节点所在列和下一列之间那条空隙的中线，列内较宽的分叉不算空隙', () => {
  const source = box(132, 640);
  const group = [
    box(132, 0), box(0, 80), box(264, 80), source, // column 1: 0..504 (a fork makes it wider than the source)
    box(504 + COLUMN_GAP, 0), box(504 + COLUMN_GAP, 80), // column 2
    box(504 + COLUMN_GAP + 240 + COLUMN_GAP, 0), // column 3
  ];
  expect(columnGapX(source, group)).toBe(504 + COLUMN_GAP / 2);
  expect(columnGapX(source, [source])).toBeNull();
});

test('sideLink：从源节点右侧出，沿空隙中线走，从目标左侧进', () => {
  expect(sideLink(box(0, 640), box(312, 0), 276)).toEqual([{ x: 240, y: 665 }, { x: 276, y: 665 }, { x: 276, y: 25 }, { x: 312, y: 25 }]);
});

test('turnLink：同一行的相邻轮次走两个轮次之间的空隙', () => {
  const sourceTurn = box(0, 0, 340, 88);
  const targetTurn = box(340 + TURN_GAP_X, 0, 340, 88);
  const pts = turnLink(box(0, 28, 340, 60), box(340 + TURN_GAP_X, 28, 340, 60), sourceTurn, targetTurn);
  expect(roundedPath(pts)).toBe(`M 340 58 L ${340 + TURN_GAP_X} 58`);
});

test('turnLink：换行时从行尾绕到下一行行首，横线走在两行之间的空隙里，不穿过任何轮次', () => {
  const sourceTurn = box(1212, 0, 340, 400);
  const targetTurn = box(0, 400 + TURN_GAP, 340, 88);
  const pts = turnLink(box(1212, 28, 340, 60), box(0, 400 + TURN_GAP + 28, 340, 60), sourceTurn, targetTurn);
  expect(pts).toEqual([
    { x: 1552, y: 58 }, { x: 1552 + TURN_GAP_X / 2, y: 58 }, { x: 1552 + TURN_GAP_X / 2, y: 400 + TURN_GAP / 2 },
    { x: -TURN_GAP_X / 2, y: 400 + TURN_GAP / 2 }, { x: -TURN_GAP_X / 2, y: 400 + TURN_GAP + 58 }, { x: 0, y: 400 + TURN_GAP + 58 },
  ]);
});
