// ts-jest AST transformer: jest runs ts as CommonJS, where `import.meta` is a syntax error.
// Replaces `import.meta` with a stub object so modules that build worker URLs can be loaded.
const ts = require('typescript');

module.exports = {
    name: 'import-meta-stub',
    version: 1,
    factory() {
        return (ctx) => (sf) => {
            const visit = (node) => {
                if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
                    return ts.factory.createObjectLiteralExpression([
                        ts.factory.createPropertyAssignment('url', ts.factory.createStringLiteral('file:///jest/module.js')),
                    ]);
                }
                return ts.visitEachChild(node, visit, ctx);
            };
            return ts.visitNode(sf, visit);
        };
    },
};
