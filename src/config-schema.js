/**
 * Optional schemastery Config schema.
 *
 * A copied/published install can resolve the host's schemastery package, which
 * gives the plugin a declarative Config (validated by the Loader and rendered as
 * a settings form). A locally linked checkout cannot resolve bare host
 * packages, so this module resolves to `undefined` and the plugin validates its
 * config itself with the same defaults.
 * @module dsh-pre-compact/config-schema
 */

import { loadConfigSchema } from './config.js'

export default await loadConfigSchema()
