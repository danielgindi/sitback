const XML = require('pixl-xml');
const Fs = require('fs');

function _parseJsonPath(path) {
    if (!path.startsWith('$'))
        throw new Error('Invalid JSON path. Must start with a $.');

    path = path.substr(1);

    let parts = path.match(/\[[0-9]+\]|\.[$A-Za-z_][0-9A-Za-z_$]*|\."(?:[^"\\]|\\.)*"/g) || [];

    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];

        if (part[0] === '[') {
            let index = part.substr(1, part.length - 2);
            parts[i] = parseInt(index, 10);
        }
        else {
            let key = part.substr(1);
            if (key[0] === '"')
                key = part.substr(1, part.length - 2).replace(/\\(.)/g, '$1');
            
            parts[i] = key;
        }
    }
    
    return parts;
}

function _findElByPath(tree, path) {
    let el = tree, parent = undefined;
    let name = null;
    let matchedKey = null;

    path = _parseJsonPath(path);

    for (let key of path) {
        if (!el) {
            parent = undefined;
            el = undefined;
        }

        parent = el;
        el = el[key];
        matchedKey = key;
            
        if (typeof key !== 'number')
            name = key;
    }

    return {
        el: el,
        name: name,
        key: matchedKey,
        parent: parent,
    };
}

class XmlUtil {
    static parseXmlAtFile(file) {
        let documentSource = Fs.readFileSync(file, { encoding: 'utf8' });

        return XmlUtil.parseXml(
            documentSource,
            { preserveAttributes: true, preserveDocumentNode: true, preserveWhitespace: true }
        );
    }
    static parseXml(xml) {
        return XML.parse(
            xml,
            { preserveAttributes: true, preserveDocumentNode: true, preserveWhitespace: true }
        );
    }

    static extractSection(xmlTree, path = '$') {
        let search = _findElByPath(xmlTree, path);

        if (search.el !== undefined) {
            return search.name === null ? search.el : { [search.name]: search.el } ;
        }
        
        return null;
    }

    static replaceSectionInto(section, xmlTree, path = '$') {
        let search = _findElByPath(xmlTree, path);

        if (search.parent !== undefined) {
            search.parent[search.key] = section[Object.keys(section)[0]];
        }

        return xmlTree;
    }

    static insertSectionInto(section, xmlTree, path = '$') {
        let search = _findElByPath(xmlTree, path);

        let key = Object.keys(section)[0];

        if (search.el !== undefined) {
            if (Array.isArray(search.el[key])) {
                search.el[key].push(section[key]);
            }
            else if (Object.prototype.hasOwnProperty.call(search.el, key)) {
                search.el[key] = [search.el[key], section[key]];
            }
            else {
                search.el[key] = section[key];
            }
        }

        return xmlTree;
    }
    
    static stringify(xmlTree) {
        return XML.stringify(xmlTree, false, 0, '  ', '\n', false);
    }
}

module.exports = XmlUtil;