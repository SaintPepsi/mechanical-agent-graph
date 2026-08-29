// One row of a bar chart. `value` scales the bar, `display` is what the reader sees, and `tone`
// picks the colour role it is drawn in.
export type BarTone = 'primary' | 'alt' | 'ok' | 'fail' | 'unfinished' | 'abandoned';

export type Bar = {
	readonly label: string;
	readonly value: number;
	readonly display: string;
	readonly tone?: BarTone;
};
