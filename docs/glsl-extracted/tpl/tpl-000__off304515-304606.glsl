// template literal at char 304515..304606  body length 90  glsl-marker-hits 2
// context before: "ction _L(s){const e=[];for(let t=0;t<s.length;t++)e.push(s[t].clone());return e}function oS(s){const e=s.getRenderTarget();return e===null?s.outputColorSpace:e.isXRRenderTarget===!0?e.texture.colorSpace:pt.workingColorSpace}const il={clone:nl,merge:Pn};var bL="
// context after : ",wL=`void main() {\n\tgl_FragColor = vec4( 1.0, 0.0, 0.0, 1.0 );\n}`;class Bt extends cn{static get type(){return\"ShaderMaterial\"}constructor(e){super(),this.isShaderMaterial=!0,this.defines={},this.uni"
// ======================================================================
void main() {
	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
