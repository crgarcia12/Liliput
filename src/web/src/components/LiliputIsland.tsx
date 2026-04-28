'use client';

import { useRef, useMemo, useState, useEffect } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Text, Float, Stars } from '@react-three/drei';
import * as THREE from 'three';
import type { Agent, AgentRole } from '@shared/types';

const ROLE_COLORS: Record<AgentRole, string> = {
  architect: '#3b82f6',
  coder: '#22c55e',
  builder: '#f97316',
  tester: '#a855f7',
  deployer: '#ef4444',
  reviewer: '#06b6d4',
  researcher: '#eab308',
  fixer: '#ec4899',
};

const BUILDING_DATA = [
  { position: [0, 0.5, 0] as [number, number, number], size: [0.6, 1.0, 0.6] as [number, number, number], color: '#3b82f6', label: 'HQ' },
  { position: [1.5, 0.35, 0.5] as [number, number, number], size: [0.5, 0.7, 0.5] as [number, number, number], color: '#22c55e', label: 'Code' },
  { position: [-1.2, 0.3, 0.8] as [number, number, number], size: [0.4, 0.6, 0.4] as [number, number, number], color: '#f97316', label: 'Build' },
  { position: [0.7, 0.25, -1.2] as [number, number, number], size: [0.5, 0.5, 0.5] as [number, number, number], color: '#a855f7', label: 'Test' },
  { position: [-0.8, 0.3, -1.0] as [number, number, number], size: [0.4, 0.6, 0.4] as [number, number, number], color: '#ef4444', label: 'Deploy' },
  { position: [1.8, 0.2, -0.5] as [number, number, number], size: [0.3, 0.4, 0.3] as [number, number, number], color: '#06b6d4', label: 'Review' },
];

// --- Sub-components ---

function Island() {
  const meshRef = useRef<THREE.Mesh>(null);

  useFrame((_, delta) => {
    if (meshRef.current) {
      meshRef.current.rotation.y += delta * 0.05;
    }
  });

  return (
    <group ref={meshRef}>
      {/* Island base — rough layered look */}
      <mesh position={[0, -0.3, 0]}>
        <cylinderGeometry args={[2.8, 2.2, 0.6, 32]} />
        <meshStandardMaterial color="#2d5a27" roughness={0.9} />
      </mesh>
      <mesh position={[0, -0.8, 0]}>
        <cylinderGeometry args={[2.2, 1.5, 0.7, 24]} />
        <meshStandardMaterial color="#8B6914" roughness={1} />
      </mesh>
      <mesh position={[0, -1.4, 0]}>
        <cylinderGeometry args={[1.5, 0.8, 0.8, 18]} />
        <meshStandardMaterial color="#6B4423" roughness={1} />
      </mesh>
      {/* Dripping rocks at the bottom */}
      <mesh position={[0.3, -1.9, 0.2]}>
        <coneGeometry args={[0.3, 0.6, 8]} />
        <meshStandardMaterial color="#5a3a1a" roughness={1} />
      </mesh>
      <mesh position={[-0.4, -2.0, -0.1]}>
        <coneGeometry args={[0.2, 0.5, 6]} />
        <meshStandardMaterial color="#4a2a10" roughness={1} />
      </mesh>

      {/* Grass top */}
      <mesh position={[0, 0.02, 0]}>
        <cylinderGeometry args={[2.8, 2.8, 0.04, 32]} />
        <meshStandardMaterial color="#3a7a34" roughness={0.8} />
      </mesh>

      {/* Buildings */}
      {BUILDING_DATA.map((b, i) => (
        <group key={i} position={b.position}>
          <mesh position={[0, 0, 0]}>
            <boxGeometry args={b.size} />
            <meshStandardMaterial color={b.color} roughness={0.6} metalness={0.1} />
          </mesh>
          {/* Roof */}
          <mesh position={[0, b.size[1] / 2 + 0.15, 0]}>
            <coneGeometry args={[b.size[0] * 0.7, 0.3, 4]} />
            <meshStandardMaterial color="#8B4513" roughness={0.8} />
          </mesh>
          <Text
            position={[0, b.size[1] / 2 + 0.55, 0]}
            fontSize={0.15}
            color="#ffffff"
            anchorX="center"
            anchorY="bottom"
            outlineWidth={0.02}
            outlineColor="#000000"
          >
            {b.label}
          </Text>
        </group>
      ))}

      {/* Trees */}
      {[
        [2.0, 0, 1.2],
        [-2.0, 0, 0],
        [0, 0, 2.2],
        [-1.5, 0, 1.8],
        [1.0, 0, 1.8],
      ].map((pos, i) => (
        <group key={`tree-${i}`} position={pos as [number, number, number]}>
          <mesh position={[0, 0.3, 0]}>
            <cylinderGeometry args={[0.05, 0.07, 0.4, 6]} />
            <meshStandardMaterial color="#5a3a1a" />
          </mesh>
          <mesh position={[0, 0.65, 0]}>
            <coneGeometry args={[0.2, 0.5, 8]} />
            <meshStandardMaterial color="#1a6a1a" />
          </mesh>
        </group>
      ))}
    </group>
  );
}

function AgentFigure({
  agent,
  index,
  total,
}: {
  agent: Agent;
  index: number;
  total: number;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const [scale, setScale] = useState(0.01);
  const color = ROLE_COLORS[agent.role] || '#ffffff';
  const isWorking = agent.status === 'working';

  // Pop-in animation
  useEffect(() => {
    setScale(0.01);
    const timer = setTimeout(() => setScale(1), 50);
    return () => clearTimeout(timer);
  }, [agent.id]);

  useFrame((state) => {
    if (!groupRef.current) return;
    // Smooth scale transition
    groupRef.current.scale.lerp(new THREE.Vector3(scale, scale, scale), 0.1);
    // Bob up and down when working
    if (isWorking) {
      groupRef.current.position.y = 0.3 + Math.sin(state.clock.elapsedTime * 3 + index) * 0.1;
    }
  });

  // Place agents in a circle around the island
  const angle = (index / Math.max(total, 1)) * Math.PI * 2;
  const radius = 1.6;
  const x = Math.cos(angle) * radius;
  const z = Math.sin(angle) * radius;

  return (
    <group ref={groupRef} position={[x, 0.3, z]}>
      {/* Body (capsule = cylinder + spheres) */}
      <mesh position={[0, 0.15, 0]}>
        <capsuleGeometry args={[0.08, 0.15, 8, 16]} />
        <meshStandardMaterial
          color={color}
          emissive={isWorking ? color : '#000000'}
          emissiveIntensity={isWorking ? 0.3 : 0}
        />
      </mesh>
      {/* Head */}
      <mesh position={[0, 0.38, 0]}>
        <sphereGeometry args={[0.07, 16, 16]} />
        <meshStandardMaterial color="#fde68a" />
      </mesh>

      {/* Label */}
      {agent.currentAction && (
        <Text
          position={[0, 0.6, 0]}
          fontSize={0.08}
          color={color}
          anchorX="center"
          anchorY="bottom"
          maxWidth={1.5}
          outlineWidth={0.01}
          outlineColor="#000000"
        >
          {agent.currentAction.slice(0, 30)}
        </Text>
      )}

      {/* Sparkle particles on completion */}
      {agent.status === 'completed' && <CompletionSparkles color={color} />}
    </group>
  );
}

function CompletionSparkles({ color }: { color: string }) {
  const pointsRef = useRef<THREE.Points>(null);
  const [opacity, setOpacity] = useState(1);

  const positions = useMemo(() => {
    const arr = new Float32Array(30);
    for (let i = 0; i < 30; i++) {
      arr[i] = (Math.random() - 0.5) * 0.5;
    }
    return arr;
  }, []);

  useFrame((_, delta) => {
    if (pointsRef.current) {
      pointsRef.current.rotation.y += delta * 2;
      const posArray = pointsRef.current.geometry.attributes.position.array as Float32Array;
      for (let i = 1; i < posArray.length; i += 3) {
        posArray[i] += delta * 0.5;
      }
      pointsRef.current.geometry.attributes.position.needsUpdate = true;
    }
    setOpacity((prev) => Math.max(0, prev - delta * 0.5));
  });

  if (opacity <= 0) return null;

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          args={[positions, 3]}
        />
      </bufferGeometry>
      <pointsMaterial
        color={color}
        size={0.03}
        transparent
        opacity={opacity}
      />
    </points>
  );
}

function Scene({ agents }: { agents: Agent[] }) {
  return (
    <>
      <ambientLight intensity={0.4} />
      <directionalLight position={[5, 8, 5]} intensity={1} castShadow />
      <directionalLight position={[-3, 4, -3]} intensity={0.3} color="#4488ff" />

      <Stars radius={50} depth={50} count={1000} factor={2} fade />

      <Float speed={1} rotationIntensity={0.1} floatIntensity={0.3}>
        <Island />
        {agents.map((agent, i) => (
          <AgentFigure key={agent.id} agent={agent} index={i} total={agents.length} />
        ))}
      </Float>

      <OrbitControls
        enablePan={false}
        minDistance={3}
        maxDistance={12}
        autoRotate
        autoRotateSpeed={0.3}
        target={[0, -0.3, 0]}
      />
    </>
  );
}

// --- Main exported component ---

interface LiliputIslandProps {
  agents: Agent[];
}

export default function LiliputIsland({ agents }: LiliputIslandProps) {
  return (
    <div className="w-full h-full rounded-lg overflow-hidden border border-[#1a1a2e] bg-[#050510]">
      <Canvas
        camera={{ position: [4, 3, 5], fov: 45 }}
        gl={{ antialias: true }}
      >
        <Scene agents={agents} />
      </Canvas>
    </div>
  );
}
