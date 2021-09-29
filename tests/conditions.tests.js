import test from 'ava';
import Packer from '../lib/packer.js';

test('Conditions: and', async t => {

    let packer = new Packer('test');

    t.is(await packer._validateCondition({ 'and': [true, false] }, {}), false);
    t.is(await packer._validateCondition({ 'and': [true, true] }, {}), true);
    t.is(await packer._validateCondition({ 'and': [false, true] }, {}), false);
    t.is(await packer._validateCondition({ 'and': [false, false] }, {}), false);

});

test('Conditions: or', async t => {

    let packer = new Packer('test');

    t.is(await packer._validateCondition({ 'or': [true, false] }, {}), true);
    t.is(await packer._validateCondition({ 'or': [true, true] }, {}), true);
    t.is(await packer._validateCondition({ 'or': [false, true] }, {}), true);
    t.is(await packer._validateCondition({ 'or': [false, false] }, {}), false);

});

test('Conditions: with variables', async t => {

    let packer = new Packer('test');

    t.is(await packer._validateCondition('a', { 'a': true }), true);
    t.is(await packer._validateCondition('a', { 'a': false }), false);
    t.is(await packer._validateCondition({ 'or': ['a', 'b'] }, { 'a': false, 'b': true }), true);
    t.is(await packer._validateCondition({ 'and': ['a', 'b'] }, { 'a': false, 'b': true }), false);
    t.is(await packer._validateCondition({ 'or': ['a', 'b'] }, { 'a': true, 'b': true }), true);
    t.is(await packer._validateCondition({ 'and': ['a', 'b'] }, { 'a': true, 'b': true }), true);
    t.is(await packer._validateCondition({ 'or': ['a', 'b'] }, { 'a': true, 'b': false }), true);
    t.is(await packer._validateCondition({ 'and': ['a', 'b'] }, { 'a': true, 'b': false }), false);
    t.is(await packer._validateCondition({ 'or': ['a', 'b'] }, { 'a': false, 'b': false }), false);
    t.is(await packer._validateCondition({ 'and': ['a', 'b'] }, { 'a': false, 'b': false }), false);

});
