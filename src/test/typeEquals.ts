/** `true` only when `A` and `B` are the same type — for compile-time table checks in tests. */
export type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
