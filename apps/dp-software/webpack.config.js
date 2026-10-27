const { composePlugins, withNx } = require('@nrwl/webpack');
const { withReact } = require('@nrwl/react');

module.exports = composePlugins(withNx(), withReact(), (config) => {
    config.resolve.extensionAlias = { '.js': ['.ts', '.js'] };
    config.output.scriptType = undefined;
    return config;
});
