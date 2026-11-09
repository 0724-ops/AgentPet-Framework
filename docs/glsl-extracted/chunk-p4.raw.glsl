// chunk "p4" — character fragment shader
// source chars 927011..939121 of vendor\site\Da0XtQgu.js (verbatim template-literal body, ${...} interpolations preserved)
// ============================================================================

#include <common>
uniform sampler2D Q71;uniform vec3 Q69;uniform float Q190;uniform float Q65;uniform vec3 Q156;uniform vec3 Q155;uniform vec3 Q209;uniform float Q211;uniform float Q210;uniform float Q279;uniform float Q278;uniform sampler2D Q100;uniform sampler2D Q277;uniform sampler2D Q143;uniform sampler2D Q255;uniform sampler2D Q256;uniform sampler2D Q263;uniform float Q159;uniform float Q260;uniform float Q266;uniform vec3 Q268;uniform vec3 Q273;uniform float Q208;uniform float Q122;uniform vec3 Q257;uniform float Q274;uniform float Q132;uniform sampler2D Q151;uniform vec2 Q152;uniform vec3 Q130;uniform vec3 Q131;uniform vec3 Q129;varying vec2 vUv;varying vec3 Q325;varying vec3 Q326;
${dT}
${d4}
${f4}
${cT}
#ifdef Q20
${aT}
#endif
vec3 R206(vec3 c){c=clamp(c,0.0,1.0);return mix(c*12.92,1.055*pow(c,vec3(1.0/2.4))-0.055,step(0.0031308,c));}vec3 R202(vec3 c){return mix(c/12.92,pow((c+0.055)/1.055,vec3(2.4)),step(0.04045,c));}vec3 R180(vec3 R121){float n=Q159;vec3 c=R206(R121)*(n-1.0);float b0=floor(c.b);float b1=min(b0+1.0,n-1.0);float v=1.0-(c.g+0.5)/n;vec3 s0=texture2D(Q263,vec2((b0*n+c.r+0.5)/(n*n),v)).rgb;vec3 s1=texture2D(Q263,vec2((b1*n+c.r+0.5)/(n*n),v)).rgb;return R202(mix(s0,s1,c.b-b0));}float R74(vec3 L){float f=dot(L,Q130);float s=dot(L,Q131);float len=length(vec2(f,s));float angle=len<1e-4?0.0:acos(clamp(f/len,-1.0,1.0))/PI;vec2 uv=s<0.0?vUv:vec2(1.0-vUv.x,vUv.y);float R170=texture2D(Q255,uv).b;return smoothstep(angle- ${Xb.toFixed(3)},angle+ ${Xb.toFixed(3)},R170);}const float R30= ${ya.sdfBias.toFixed(3)};const float R29= ${ya.ambient.toFixed(3)};const float R3= ${e4.toFixed(4)};const float R11= ${t4.toFixed(4)};float R203(vec3 c){return dot(c,vec3(0.212673,0.715152,0.072175));}float R75(vec3 L){float f=dot(L,Q130);float s=dot(L,Q131);vec2 l=vec2(s,f)/max(length(vec2(s,f)),1e-4);float t=clamp(l.y+R30,-1.0,1.0);vec2 uv=s<0.0?vUv:vec2(1.0-vUv.x,vUv.y);vec4 m=texture2D(Q255,uv);float R78=0.5*(m.r+m.g);float e=clamp(0.5-0.5*t,0.001,0.999);float k=smoothstep(max(2.0*e-1.0,0.0),min(2.0*e,1.0),R78);return 2.0*k-1.0+max(t,0.0);}uniform vec4 Q144;uniform float Q66;uniform float Q123;
#ifdef Q38
uniform vec3 Q271;uniform vec4 Q270;uniform vec2 Q269;
#endif
#ifdef Q10
uniform sampler2D Q120;uniform vec3 Q121;
#endif
#ifdef Q3
const float R25= ${wd.floor.toFixed(3)};const float R24= ${wd.ceiling.toFixed(3)};const float R26= ${wd.panel.toFixed(3)};const float R27= ${wd.panelCos.toFixed(3)};vec3 R204(vec3 R22,float R163,vec3 R7){float w=0.05+0.6*R163*R163;float R162=mix(R25,R24,smoothstep(-0.5-w,0.5+w,R22.y));vec3 R9=normalize(vec3(R7.x,max(R7.y,0.3),R7.z));float R144=smoothstep(R27-w,R27+0.5*w,dot(R22,R9))*R26/(1.0+6.0*R163*R163);return vec3(R162+R144);}vec3 R201(vec3 R4,float R163,float R14){float r2=R163*R163;float R155=r2*r2*r2;float v2=R14*R14;float v3=v2*R14;float x=(0.036546+3.32707*R14+(9.0632-9.04756*R14)*r2)/(1.0+3.59685*v2-1.36772*v3+(9.04401-16.3174*v2+9.22949*v3)*r2+(5.56589+19.7886*v2-20.2123*v3)*R155);float y=(0.99044-1.28514*R14+(1.29678-0.755907*R14)*r2)/(1.0+2.92338*R14+59.4188*v3+(20.3225-27.0302*R14+222.592*v3)*r2+(121.563+626.13*R14+316.627*v3)*R155);vec3 R61=R4*x+y;float e=x+y;return R61*(1.0+R4*(1.0-e)/e);}
#endif
#ifdef Q11
uniform sampler2D Q140;uniform vec4 Q142;uniform float Q141;
#endif
#ifdef Q23
uniform sampler2D Q127;uniform vec3 Q128;uniform vec3 Q126;varying vec2 Q321;
#endif
#ifdef Q17
uniform sampler2D Q198;uniform vec4 Q205;uniform vec3 Q199;uniform float Q206;uniform float Q202;float R145(vec3 N,vec3 V){vec2 R214=vec2(vUv.x,1.0-vUv.y);vec3 R65=dFdx(Q326);vec3 R67=dFdy(Q326);vec2 R69=dFdx(R214);vec2 R70=dFdy(R214);vec3 R68=cross(R67,N);vec3 R66=cross(N,R65);vec3 T=R68*R69.x+R66*R70.x;vec3 B=R68*R69.y+R66*R70.y;float frame=inversesqrt(max(max(dot(T,T),dot(B,B)),1e-20));vec3 R221=normalize(vec3(dot(T*frame,V),dot(B*frame,V),dot(N,V)));vec2 R212=R214*Q205.xy+Q205.zw;vec2 gx=dFdx(vUv);vec2 gy=dFdy(vUv);float n=min(20.0,Q202);float R196=1.0/n;vec2 delta= -(R221.xy/max(R221.z,0.001))*Q206*R196;vec2 off=delta;float layer=1.0-R196;vec2 R150=vec2(0.0);float R147=0.0;float R148=1.0;float h=0.0;bool R116=false;for(int i=0;i<21;i++){if(float(i)>=n+1.0)break;vec2 p=R212+off;h=textureGrad(Q198,vec2(p.x,1.0-p.y),gx,gy).r;if(layer<h){R116=true;break;}R150=off;R147=h;R148=layer;off+=delta;layer-=R196;}if(!R116)h=R147;float above=R147-R148;float R192=above-(h-layer);vec2 p=R212+R150+delta*(abs(R192)>1e-6?above/R192:0.0);return texture2D(Q198,vec2(p.x,1.0-p.y)).r;}
#endif
void main(){vec4 base=R200(Q71,Q69,Q190,vUv);
#ifdef Q23
vec4 extra=texture2D(Q127,Q321);float R55=R200(Q71,vec3(1.0),1.0,vUv).a;base.a=Q190*extra.a;base.rgb*=mix(Q128,vec3(1.0),extra.g)*mix(Q126,vec3(1.0),extra.b);
#endif
#ifdef Q1
if(base.a<Q65)discard;
#endif
#ifdef Q11
vec2 R72=vec2(vUv.x,1.0-vUv.y)*Q142.xy+Q142.zw;vec3 R71=texture2D(Q140,vec2(R72.x,1.0-R72.y)).rgb;base.rgb=mix(base.rgb,1.0-(1.0-base.rgb)*(1.0-R71),Q141);
#endif
float R226=R223(Q326,vUv);vec3 N=normalize(Q325);
#ifdef DOUBLE_SIDED
N*=gl_FrontFacing?1.0: -1.0;
#endif
vec3 L=normalize(Q156);vec3 V=normalize(cameraPosition-Q326);vec3 R5=normalize(L+V);float R16=dot(N,L);float R17=clamp(dot(N,V),0.0,1.0);float R15=clamp(dot(N,R5),0.0,1.0);
#ifdef Q13
#ifdef Q23
vec4 R81=texture2D(Q143,Q321);R81.b=min(R81.b,R55);
#else
vec4 R81=texture2D(Q143,vUv);
#endif
#endif
#ifdef Q20
float R171=R57(Q326,N);
#endif
#if defined(Q6) && defined(Q9)
float x=clamp(R16+Q208,-1.0,1.0);float R161=Q274;
#ifdef Q18
vec4 mask=vec4(1.0);
#ifdef Q19
mask=texture2D(Q256,vUv);
#endif
x=mix(R75(L),x,mask.g);R161=mix(Q132,Q274,mask.b)*mask.r;
#endif
float R188=clamp(0.85*(1.0-R17)*R161,0.0,1.0);vec4 R157=texture2D(Q100,vec2(clamp(x*0.5+0.5,0.002,0.998),0.5));
#ifdef Q20
float R179=1.0;float R181=1.0;
#ifdef Q18
vec3 R175=vec3(viewMatrix[0][2],viewMatrix[1][2],viewMatrix[2][2]);vec2 R177=vec2(dot(R175,Q131),dot(R175,Q130));float R178=clamp(1.5-2.0*R177.y/max(length(R177),1e-4),0.0,1.0);R178=R178*R178*(3.0-2.0*R178);R179=max(mask.b*R178,mask.g);R181=mask.g;
#endif
float R28=mix(1.0,R171,R179);float R173=min(base.a,min(R28,R157.a));float R60=base.a*mix(1.0,R28,R181);
#else
float R173=min(base.a,R157.a);float R60=base.a;
#endif
#ifdef Q21
vec3 R172=R180(base.rgb);
#else
vec3 R172=R205(base.rgb,Q266)*Q260;
#endif
R172*=0.96*Q122;vec3 R124=base.rgb*mix(vec3(1.0),Q257,R188)*0.96;float R127=R203(0.65*R172);vec3 R44=mix(R127+1.2*(0.65*R172-R127),R172,clamp(R60+R157.a,0.0,1.0));R44=mix(R44,R124,R173);float R158=max(R157.r,max(R157.g,R157.b))-min(R157.r,min(R157.g,R157.b));vec3 color=R44*mix(vec3(1.0),R157.rgb,R158);color*=clamp(R203(R44)/max(R203(color),0.001),0.0,1.5);vec3 R186=Q273*R11;vec3 R187=mix(Q268,vec3(1.0),R173)*R29*R3*Q273+mix(vec3(R203(R186)),R186,R173);vec3 R38=color;color*=R187;
#ifdef Q14
vec2 R118=vUv+vec2(-dot(V,Q131),0.0)*Q152.x;color+=texture2D(Q151,R118).rgb*R187*mix(Q122,1.0,R173)*(0.5+0.5*R173);
#endif
vec3 R40=N;vec4 R39=vec4(1.0,1.0,1.0,0.0);
#ifdef Q18
R39=mask;vec3 R156=Q326-Q129;R40=normalize(vec3(R156.x,0.000061,R156.z));
#endif
vec3 R52=vec3(viewMatrix[0][2],viewMatrix[1][2],viewMatrix[2][2]);vec2 R54=vec2(dot(R52,Q131),dot(R52,Q130));float R51=R54.y/max(length(R54),1e-4);float R37=clamp((abs(R51)-0.9)*10.0,0.0,1.0);R37=R37*R37*(3.0-2.0*R37);vec3 R41=normalize(mix(R40,N,R39.g));vec3 R36=base.rgb*0.96;
#else
float R122=clamp(R16+Q208,-1.0,1.0)*0.5+0.5;
#ifdef Q18
float R76=1.0;
#ifdef Q19
R76=1.0-texture2D(Q256,vUv).g;
#endif
R122=mix(R122,R74(L),R76);
#endif
#ifdef Q21
vec3 R176=R180(base.rgb);
#else
vec3 R176=R205(base.rgb,Q266)*Q260;
#endif
#ifdef Q38
float R184=2.0*clamp(base.a+1.0-Q270.a,0.0,1.0);float R183=mix(Q269.x,Q269.y,min(pow(1.05-R17,R184),1.0));base.rgb=mix(base.rgb*Q271,Q270.rgb,R183);R176=mix(R176*Q271,Q270.rgb,R183);
#endif
R176*=0.96*Q122;float R46=clamp(N.y+0.15,0.0,1.0)*1.5+0.5;vec3 R62=Q155*R11;
#ifdef Q9
float mask=1.0;
#ifdef Q13
mask=R81.b;
#endif
vec4 R157=texture2D(Q100,vec2(clamp(R122,0.002,0.998),0.5));float R159=texture2D(Q100,vec2(clamp(dot(N,V)*0.5+0.5,0.002,0.998),0.5)).a;
#ifdef Q20
float R173=min(R157.a,min(mask,R171));float R218=R159*mask*R171;
#else
float R173=min(R157.a,mask);float R218=R159*mask;
#endif
vec3 R172=R176;vec3 R124=base.rgb*0.96;float R127=R203(0.65*R172);vec3 R44=mix(R127+1.2*(0.65*R172-R127),R172,clamp(R157.a+R218,0.0,1.0));R44=mix(R44,R124,R173);float R158=max(R157.r,max(R157.g,R157.b))-min(R157.r,min(R157.g,R157.b));vec3 color=R44*mix(vec3(1.0),R157.rgb,R158);color*=clamp(R203(R44)/max(R203(color),0.001),0.0,1.5);
#elif defined(Q3)
vec4 g=Q144;
#ifdef Q13
g=R81;
#endif
float k=0.96*(1.0-g.r);float sx=max((clamp(R16+Q208,-1.0,1.0)-0.25)*1.333333,0.0);float s=sx*sx*(3.0-2.0*sx);vec3 R53=vec3(viewMatrix[0][2],viewMatrix[1][2],viewMatrix[2][2]);float vx=clamp((dot(N,R53)-0.25)*1.333333,0.0,1.0);float R198=vx*vx*(3.0-2.0*vx);float R195=1.0;
#ifdef Q20
R195=R171;
#endif
float R173=min(s,min(g.b,R195));float R218=R198*g.b*R195;vec3 R172=R176*(1.0-g.r);vec3 R124=base.rgb*k;float R127=R203(0.65*R172);vec3 R44=mix(R127+1.2*(0.65*R172-R127),R172,clamp(s+R218,0.0,1.0));vec3 color=mix(R44,R124,R173);
#else
float R173=smoothstep(0.48,0.52,R122);
#ifdef Q20
R173=min(R173,R171);
#endif
vec3 color=mix(R176,base.rgb,R173);
#endif
vec3 R38=color;vec3 light=mix(Q268,vec3(1.0),R173)*R46*R3*Q155+mix(vec3(R203(R62)),R62,R173);color*=light;
#if defined(Q5) && defined(Q7)
R90=vec4(1.0);
#ifdef Q13
R90=R81;
#endif
mat3 R94=Q150;vec3 R100=normalize(R94[0]);vec3 R102=normalize(R94[2]);vec3 R86=normalize(R94*vec3(Q149,1.0,0.0));vec3 R98=N*dot(N,R86)-R86;vec2 R88=vec2(dot(N,R100),dot(N,R102));vec2 R89=vec2(dot(V,R100),dot(V,R102));R88*=inversesqrt(max(dot(R88,R88),1e-8));R89*=inversesqrt(max(dot(R89,R89),1e-8));R87=pow(clamp(dot(R88,R89),0.0,1.0),Q147.w);vec3 R99=R100*dot(V,R100)+normalize(R94[1])*L.y+R102*dot(V,R102);vec3 R91=normalize(normalize(2.0*R99+L)+V);R96=normalize(N*(2.0*Q147.x-1.0)+R98);R92=0.2*R90.g*Q147.z;vec3 R84=R93(R91);vec3 R97=normalize(N*(2.0*Q147.y-1.0)+R98);float R101=dot(R97,R91);float R95=max(sqrt(max(1.0-R101*R101,0.0)),1e-4);vec3 R85=R90.a*Q148.rgb*exp2(Q148.w*log2(R95))*R87*(1.0-max(R84.r,max(R84.g,R84.b)));color+=(R84*R92+R85)*light*mix(Q122,1.0,R173)*(0.5+0.5*R173);
#endif
#if defined(Q35) && !defined(Q3)
color*=base.a;
#endif
vec3 R40=N;vec3 R41=N;float R37=0.0;vec4 R39=vec4(0.0);vec3 R36=base.rgb*0.96;
#ifdef Q3
R36=R124;float R146=mix(1.0,base.a,Q66);color*=R146;float R163=1.0-g.a;float a=max(R163*R163,0.007812);float a2=a*a;vec3 R6=normalize(L+2.0*normalize(vec3(R53.x,L.y,R53.z))+3.0*V);float R13=dot(N,R6);float dd=R13*R13*(a2-1.0)+1.0;dd*=dd;float D=dd!=a2?a2/dd:1.0;float R14=clamp(dot(N,V),0.0,1.0);float spec=clamp(D*0.5/(2.0*R14+a+0.0001)-0.000061,0.0,20.0);vec3 R4=mix(vec3(0.04*g.g),base.rgb,g.r);float R193=mix(Q122,1.0,R173);color+=light*(0.5+0.5*R173)*R193*spec*R4;float R126=R203(color);float R120=clamp(R126-0.5,0.0,0.5);color=R126+(color-R126)*(R120*R120+1.0);
#ifdef Q10
color+=texture2D(Q120,vUv).rgb*Q121*R146;
#endif
#ifdef Q17
color+=R145(N,V)*Q199*base.a*R146;
#endif
vec3 R22=reflect(-V,N);color+=R204(R22,R163,L)*R201(R4,R163,R14)*clamp(R3,0.5,1.5)*Q123*R193*Q268;
#endif
#endif
color+=R43(N,R41,R40,V,R38,R36,R37,R39.a);
#if defined(Q4) && defined(Q12) && !defined(Q3)
float R190=R81.a;float R115=pow(R15,exp2(mix(3.0,9.0,R190)))*R190;R115=smoothstep(0.35,0.6,R115)*step(0.0,R16);vec3 tint=vec3(1.0);
#ifdef Q22
tint=texture2D(Q277,vec2(R15,1.0-R190)).rgb;
#endif
tint=mix(tint,tint*base.rgb*2.0,R81.r);color+=R115*tint*Q278*Q279*Q155*R11;
#endif
#if defined(Q5) && defined(Q22) && !defined(Q7)
vec3 band=texture2D(Q277,vec2(R15,0.5)).rgb;color+=band*base.rgb*Q279*smoothstep(0.0,0.2,R16)*Q155*R11;
#endif
float R160=smoothstep(1.0-Q211,1.0,1.0-R17)*Q210*(Q60>0?0.0:1.0);color+=R160*Q209*mix(vec3(1.0),base.rgb,0.5);
#if defined(Q4) && !defined(Q3)
#ifdef Q10
color+=texture2D(Q120,vUv).rgb*Q121*mix(1.0,base.a,Q66);
#endif
#ifdef Q17
color+=R145(N,V)*Q199*base.a*mix(1.0,base.a,Q66);
#endif
#endif
color+=R226*Q91*mix(1.0,base.a,Q66);
#ifdef Q27
gl_FragColor=vec4(color,base.a);
#else
gl_FragColor=vec4(color,1.0);
#endif
#include <tonemapping_fragment>
#include <colorspace_fragment>
}

