// The home page is a function of this one value; nothing on it is view state of its own.
export type HomeState = {
	readonly graphs: ReadonlyArray<{ readonly name: string }>;
	readonly runs: ReadonlyArray<{ readonly id: string }>;
};

export const emptyHome: HomeState = { graphs: [], runs: [] };

export type HomeSection = { readonly title: string; readonly count: number; readonly empty: string };

export const homeSections = (state: HomeState): ReadonlyArray<HomeSection> => [
	{ title: 'Graphs', count: state.graphs.length, empty: 'No graphs registered.' },
	{ title: 'Runs', count: state.runs.length, empty: 'No runs on this machine.' }
];
