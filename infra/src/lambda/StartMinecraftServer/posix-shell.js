/** Quote one value as a single POSIX shell word. */
export const quotePosixShellArgument = (value) => `'${String(value).split("'").join(`'"'"'`)}'`;
