declare module 'terminal-kit' {
	interface Terminal {
		(text: string): Terminal;
		clear(): void;
		grabInput(grab: boolean | { mouse?: string; focus?: boolean }): void;
		width: number;
		height: number;
		eraseLine(): Terminal;
		eraseDisplayBelow(): Terminal;
		column(col: number): Terminal;
		moveTo(x: number, y: number): Terminal;
		up(rows: number): Terminal;
		down(rows: number): Terminal;
		getCursorLocation(callback?: (err: any, x: number, y: number) => void): { x: number; y: number } | void;
		fullscreen(enabled: boolean): void;
		hideCursor(hide: boolean): void;
		processExit(code: number): void;
		on(event: string, handler: (...args: any[]) => void): void;
		off(event: string, handler: (...args: any[]) => void): void;
		inputField(
			options: {
				history?: string[];
				autoComplete?: string[] | ((input: string) => string | string[]);
				autoCompleteMenu?: boolean;
				autoCompleteHint?: boolean;
				cancelable?: boolean;
			},
			callback: (error: any, input: string) => void
		): any;

		// Color methods that return Terminal for chaining
		gray: Terminal;
		white: Terminal;
		blue: Terminal;
		green: Terminal;
		yellow: Terminal;
		red: Terminal;
		magenta: Terminal;
		cyan: Terminal;

		// Style methods
		bold: Terminal;
		italic: Terminal;
		inverse: Terminal;
	}

	interface TermKit {
		terminal: Terminal;
	}

	const termkit: TermKit;
	export = termkit;
}
