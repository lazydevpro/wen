import {loadFont as loadTektur} from '@remotion/google-fonts/Tektur';
import {loadFont as loadSourceCodePro} from '@remotion/google-fonts/SourceCodePro';
import {loadFont as loadInter} from '@remotion/google-fonts/Inter';

/**
 * Loaded once, here, with the weights and subset pinned to exactly what web/index.html requests.
 *
 * Unpinned, each loadFont() call fetches every weight and every subset — over a hundred requests
 * per font, repeated for every module that imports it. That is slow on a 1,260-frame render and
 * flaky when a request drops mid-render.
 */
// `subsets` is typed as a mutable array, so this cannot be `as const`
const base = () => ({subsets: ['latin' as const], ignoreTooManyRequestsWarning: true});

export const display = loadTektur('normal', {...base(), weights: ['500']}).fontFamily;
export const mono = loadSourceCodePro('normal', {...base(), weights: ['400', '600']}).fontFamily;
export const sans = loadInter('normal', {...base(), weights: ['400', '500']}).fontFamily;
