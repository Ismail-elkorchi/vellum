import type { AppState, BufferId, NavigationLocation } from '../app/types.js';

const limit = 200;

export function pushNavigationLocation(
  state: AppState,
  location: NavigationLocation
): AppState {
  const previous = state.commandState.navigation.back.at(-1);
  if (sameLocation(previous, location)) return state;
  return withHistory(state, {
    back: Object.freeze([...state.commandState.navigation.back, Object.freeze(location)].slice(-limit)),
    forward: Object.freeze([])
  });
}

export function navigateBack(
  state: AppState,
  current: NavigationLocation
): { readonly state: AppState; readonly destination?: NavigationLocation } {
  const destination = state.commandState.navigation.back.at(-1);
  if (destination === undefined) return Object.freeze({ state });
  return Object.freeze({
    state: withHistory(state, {
      back: Object.freeze(state.commandState.navigation.back.slice(0, -1)),
      forward: Object.freeze([current, ...state.commandState.navigation.forward].slice(0, limit))
    }),
    destination
  });
}

export function navigateForward(
  state: AppState,
  current: NavigationLocation
): { readonly state: AppState; readonly destination?: NavigationLocation } {
  const destination = state.commandState.navigation.forward[0];
  if (destination === undefined) return Object.freeze({ state });
  return Object.freeze({
    state: withHistory(state, {
      back: Object.freeze([...state.commandState.navigation.back, current].slice(-limit)),
      forward: Object.freeze(state.commandState.navigation.forward.slice(1))
    }),
    destination
  });
}

export function location(
  bufferId: BufferId,
  sourceOffset: number,
  selection?: NavigationLocation['selection']
): NavigationLocation {
  return Object.freeze({ bufferId, sourceOffset, ...(selection === undefined ? {} : { selection }) });
}

function withHistory(
  state: AppState,
  navigation: AppState['commandState']['navigation']
): AppState {
  return Object.freeze({
    ...state,
    commandState: Object.freeze({ ...state.commandState, navigation: Object.freeze(navigation) })
  });
}

function sameLocation(left: NavigationLocation | undefined, right: NavigationLocation): boolean {
  return left?.bufferId === right.bufferId
    && left.sourceOffset === right.sourceOffset
    && left.selection?.start === right.selection?.start
    && left.selection?.end === right.selection?.end;
}
