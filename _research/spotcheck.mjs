import { readText } from './asar.mjs';

function show(fileArr, from, to) {
  const ls = readText(fileArr).split('\n');
  console.log('### ' + fileArr.slice(3).join('/') + '  ' + from + '-' + to);
  console.log(ls.slice(from - 1, to).map((l, i) => (from + i) + ': ' + l).join('\n'));
  console.log('');
}

const M = ['dsh', 'node_modules', '@deepseek-ai', 'dsh-client-modules', 'lib', 'client.js'];
show(M, 61, 75);
show(M, 785, 795);
show(M, 834, 843);
show(M, 96, 101);
show(M, 305, 315);
show(M, 815, 822);

const J = ['dsh', 'node_modules', '@deepseek-ai', 'dsh-client-ui-jobs', 'lib', 'client.js'];
show(J, 11, 21);
show(J, 869, 900);

const R = ['dsh', 'node_modules', '@deepseek-ai', 'dsh-client-ui-renderer', 'lib', 'client.js'];
show(R, 741, 746);
show(R, 1810, 1820);

const S = ['dsh', 'node_modules', '@deepseek-ai', 'dsh-client-ui-sidebar', 'lib', 'client.js'];
show(S, 686, 707);
