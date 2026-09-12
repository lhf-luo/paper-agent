import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useReducer,
	type ReactNode,
} from "react";
import { api } from "./api";
import type { ApplicationStatus, BackgroundJob } from "./types";

export interface WorkspaceToast {
	id: string;
	type: "success" | "error" | "info" | "warning";
	title?: string;
	message: string;
	timestamp: number;
}

interface WorkspaceState {
	namespace: string;
	availableNamespaces: string[];
	status?: ApplicationStatus;
	lastTask?: BackgroundJob;
	toasts: WorkspaceToast[];
	isRefreshing: boolean;
	error: string;
}

type WorkspaceAction =
	| { type: "SET_NAMESPACE"; payload: string }
	| { type: "SET_NAMESPACES"; payload: string[] }
	| { type: "SET_STATUS"; payload: ApplicationStatus }
	| { type: "SET_LAST_TASK"; payload: BackgroundJob }
	| { type: "SET_REFRESHING"; payload: boolean }
	| { type: "SET_ERROR"; payload: string }
	| { type: "ADD_TOAST"; payload: WorkspaceToast }
	| { type: "REMOVE_TOAST"; payload: string };

function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
	switch (action.type) {
		case "SET_NAMESPACE":
			return { ...state, namespace: action.payload };
		case "SET_NAMESPACES":
			return { ...state, availableNamespaces: action.payload };
		case "SET_STATUS":
			return {
				...state,
				status: action.payload,
				namespace: state.namespace === "default" && action.payload.defaultNamespace ? action.payload.defaultNamespace : state.namespace,
				availableNamespaces: action.payload.personalNamespaces?.length ? action.payload.personalNamespaces : state.availableNamespaces,
				error: "",
			};
		case "SET_LAST_TASK":
			return { ...state, lastTask: action.payload };
		case "SET_REFRESHING":
			return { ...state, isRefreshing: action.payload };
		case "SET_ERROR":
			return { ...state, error: action.payload };
		case "ADD_TOAST":
			return { ...state, toasts: [...state.toasts.slice(-4), action.payload] };
		case "REMOVE_TOAST":
			return { ...state, toasts: state.toasts.filter((t) => t.id !== action.payload) };
		default:
			return state;
	}
}

interface WorkspaceContextValue {
	namespace: string;
	availableNamespaces: string[];
	status?: ApplicationStatus;
	lastTask?: BackgroundJob;
	toasts: WorkspaceToast[];
	isRefreshing: boolean;
	error: string;
	setNamespace: (ns: string) => void;
	refreshStatus: () => Promise<void>;
	trackTask: (task: BackgroundJob) => void;
	pushToast: (type: WorkspaceToast["type"], message: string, title?: string) => string;
	removeToast: (id: string) => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
	const [state, dispatch] = useReducer(workspaceReducer, {
		namespace: "default",
		availableNamespaces: ["default"],
		toasts: [],
		isRefreshing: false,
		error: "",
	});

	const refreshStatus = useCallback(async () => {
		dispatch({ type: "SET_REFRESHING", payload: true });
		try {
			const res = await api<ApplicationStatus>("/api/status");
			dispatch({ type: "SET_STATUS", payload: res });
		} catch (reason) {
			dispatch({
				type: "SET_ERROR",
				payload: reason instanceof Error ? reason.message : String(reason),
			});
		} finally {
			dispatch({ type: "SET_REFRESHING", payload: false });
		}
	}, []);

	useEffect(() => {
		void refreshStatus();
		const interval = window.setInterval(() => {
			if (document.visibilityState === "visible") {
				void refreshStatus();
			}
		}, 10_000);
		return () => window.clearInterval(interval);
	}, [refreshStatus]);

	const setNamespace = useCallback((ns: string) => {
		dispatch({ type: "SET_NAMESPACE", payload: ns });
	}, []);

	const trackTask = useCallback(
		(task: BackgroundJob) => {
			dispatch({ type: "SET_LAST_TASK", payload: task });
			void refreshStatus();
		},
		[refreshStatus],
	);

	const removeToast = useCallback((id: string) => {
		dispatch({ type: "REMOVE_TOAST", payload: id });
	}, []);

	const pushToast = useCallback(
		(type: WorkspaceToast["type"], message: string, title?: string) => {
			const id = Math.random().toString(36).slice(2, 9);
			const toast: WorkspaceToast = { id, type, title, message, timestamp: Date.now() };
			dispatch({ type: "ADD_TOAST", payload: toast });
			window.setTimeout(() => {
				dispatch({ type: "REMOVE_TOAST", payload: id });
			}, 5000);
			return id;
		},
		[],
	);

	return (
		<WorkspaceContext.Provider
			value={{
				namespace: state.namespace,
				availableNamespaces: state.availableNamespaces,
				status: state.status,
				lastTask: state.lastTask,
				toasts: state.toasts,
				isRefreshing: state.isRefreshing,
				error: state.error,
				setNamespace,
				refreshStatus,
				trackTask,
				pushToast,
				removeToast,
			}}
		>
			{children}
		</WorkspaceContext.Provider>
	);
}

export function useWorkspace(): WorkspaceContextValue {
	const ctx = useContext(WorkspaceContext);
	if (!ctx) {
		throw new Error("useWorkspace must be used within a WorkspaceProvider");
	}
	return ctx;
}
